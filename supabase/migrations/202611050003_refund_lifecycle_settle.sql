-- ============================================================================
-- CLUVO — Refund ledger lifecycle + wallet clawback safety
--
-- Model (customer protection):
--   claim       -> debt recorded in payments.refund_amount_due (wallet untouched)
--   issued      -> provider accepted; debt stays reserved, wallet untouched
--   processed   -> provider paid the customer; debit organizer share once,
--                  clear the debt
--   failed      -> attempt failed but the customer is STILL owed; keep the debt,
--                  retry (never release the organizer's money prematurely)
--
-- The payout functions subtract the reserved debt (see 202611050004), so the
-- organizer cannot withdraw money that is still owed to a customer.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Schema: lifecycle columns
-- ----------------------------------------------------------------------------
ALTER TABLE public.payment_refund_history
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refund_clawback_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refund_wallet_debited_attempt INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_refund_clawback_state_check'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_refund_clawback_state_check
      CHECK (refund_clawback_state IN ('none', 'pending', 'done'));
  END IF;
END;
$$;

-- Legacy backfill. Refunds issued before this migration debited the wallet at
-- issuance (the old behavior) — mark those as already clawed back so the new
-- settle path can never debit them a second time.
UPDATE public.payments p
SET refund_clawback_state = 'done',
    refund_wallet_debited_attempt = GREATEST(COALESCE(p.refund_attempt_count, 0), 1)
WHERE COALESCE(p.refund_attempt_count, 0) > 0
  AND p.refund_clawback_state = 'none'
  AND EXISTS (
    SELECT 1 FROM public.payment_audit_log pal
    WHERE pal.payment_id = p.id
      AND pal.action = 'wallet_debited'
  );

-- Legacy refunds whose clawback failed (only an audit row, no debit) stay
-- pending: the settle path / retry job will recover them when money returns.
UPDATE public.payments p
SET refund_clawback_state = 'pending',
    refund_wallet_debited_attempt = 0
WHERE COALESCE(p.refund_attempt_count, 0) > 0
  AND p.refund_clawback_state = 'none'
  AND p.refund_status IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.payment_audit_log pal
    WHERE pal.payment_id = p.id
      AND pal.action = 'refund_wallet_debit_failed'
  );

-- ----------------------------------------------------------------------------
-- 2. claim_payment_refund — allow reclaiming a FAILED attempt.
--    A failed attempt is not "already refunded": the customer is still owed.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_payment_refund(
  p_payment_id UUID,
  p_reason TEXT DEFAULT NULL,
  p_amount INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment RECORD;
  v_reg_status TEXT;
  v_new_attempt INTEGER;
  v_is_retry BOOLEAN;
BEGIN
  SELECT p.* INTO v_payment
  FROM public.payments p
  WHERE p.id = p_payment_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  IF v_payment.status NOT IN ('success', 'failed', 'refunded')
     OR v_payment.razorpay_payment_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Payment is not refundable in its current state');
  END IF;

  SELECT r.status INTO v_reg_status
  FROM public.registrations r
  WHERE r.id = v_payment.registration_id;

  IF v_reg_status = 'attended' THEN
    RETURN jsonb_build_object(
      'error', 'not_refundable_attended',
      'message', 'Attendee already attended the event - no refund'
    );
  END IF;

  -- Terminal (accepted/processed) provider refunds: nothing to do. A failed
  -- attempt is the ONLY issued state that may be re-claimed.
  IF v_payment.refund_claim_state = 'issued'
     AND COALESCE(v_payment.refund_status, '') <> 'failed' THEN
    RETURN jsonb_build_object(
      'already_refunded', true,
      'refund_status', v_payment.refund_status,
      'razorpay_refund_id', v_payment.razorpay_refund_id
    );
  END IF;

  IF v_payment.refund_status = 'processed' THEN
    RETURN jsonb_build_object(
      'already_refunded', true,
      'refund_status', v_payment.refund_status,
      'razorpay_refund_id', v_payment.razorpay_refund_id
    );
  END IF;

  -- A fresh live claim is in flight; a stale one may be recovered.
  IF v_payment.refund_claim_state = 'claimed'
     AND v_payment.refund_claim_at IS NOT NULL
     AND v_payment.refund_claim_at > now() - interval '15 minutes' THEN
    RETURN jsonb_build_object('conflict', true, 'refund_claim_at', v_payment.refund_claim_at);
  END IF;

  v_is_retry := v_payment.refund_status = 'failed';

  v_new_attempt := COALESCE(v_payment.refund_attempt_count, 0) + 1;

  UPDATE public.payments
  SET refund_claim_state = 'claimed',
      refund_claim_at = now(),
      refund_attempt_count = v_new_attempt,
      refund_reason = COALESCE(NULLIF(p_reason, ''), v_payment.refund_reason),
      -- Never overwrite a persisted debt; derive it only when missing.
      refund_amount_due = COALESCE(v_payment.refund_amount_due, p_amount),
      -- A failed attempt keeps the same debt reservation. Starting a brand new
      -- cycle resets the clawback reservation (it has not been debited yet).
      refund_status = CASE WHEN v_is_retry THEN NULL ELSE v_payment.refund_status END,
      refund_clawback_state = CASE
        WHEN v_is_retry THEN v_payment.refund_clawback_state
        ELSE 'pending'
      END,
      refund_wallet_debited_attempt = CASE
        WHEN v_is_retry THEN v_payment.refund_wallet_debited_attempt
        ELSE 0
      END,
      updated_at = now()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'ok', true,
    'attempt', v_new_attempt,
    'stale_reclaimed', (v_payment.refund_claim_state = 'claimed'),
    'retry_of_failed', v_is_retry
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. complete_payment_refund — record the provider outcome.
--    IMPORTANT: this no longer debits the wallet at issuance. The organizer
--    share is debited exactly once, when the refund reaches 'processed'
--    (settle_payment_refund below). A failed attempt keeps the debt.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_payment_refund(
  p_payment_id uuid,
  p_success boolean,
  p_refund_id text DEFAULT NULL::text,
  p_status text DEFAULT NULL::text,
  p_amount integer DEFAULT NULL::integer,
  p_wallet_reason text DEFAULT 'payment_refund'::text,
  p_debit_wallet boolean DEFAULT TRUE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment RECORD;
  v_registration RECORD;
  v_status TEXT;
  v_amount INTEGER;
  v_attempt INTEGER;
BEGIN
  SELECT p.* INTO v_payment
  FROM public.payments p
  WHERE p.id = p_payment_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  v_status := COALESCE(NULLIF(p_status, ''), 'pending');

  -- Allow: a live claim, a retry of a failed attempt, or a processed adoption
  -- record (admin/provider sync). Never a fresh issue on a terminal refund.
  IF NOT (
    v_payment.refund_claim_state IN ('claimed', 'failed')
    OR (v_status = 'processed' AND v_payment.refund_claim_state = 'issued')
    OR v_payment.refund_status = 'failed'
  ) THEN
    RETURN jsonb_build_object('error', 'No live refund claim for this payment');
  END IF;

  v_amount := COALESCE(p_amount, v_payment.refund_amount_due, v_payment.refunded_amount, v_payment.amount);
  v_attempt := COALESCE(v_payment.refund_attempt_count, 1);

  -- Failed attempt: keep the customer debt. Only the attempt counter/status
  -- changes — the money is still owed and will be retried.
  IF NOT p_success THEN
    UPDATE public.payments
    SET refund_claim_state = 'failed',
        refund_status = 'failed',
        updated_at = now()
    WHERE id = p_payment_id;

    UPDATE public.payment_refund_history
    SET refund_status = 'failed',
        updated_at = now()
    WHERE id = (
      SELECT h.id
      FROM public.payment_refund_history h
      WHERE h.payment_id = p_payment_id
        AND h.refund_status IN ('pending', 'queued', 'requested')
      ORDER BY h.created_at DESC
      LIMIT 1
    );

    INSERT INTO public.payment_audit_log (action, payment_id, details)
    VALUES ('refund_failed', p_payment_id,
      jsonb_build_object(
        'refund_id', p_refund_id,
        'amount', v_amount,
        'attempt', v_attempt,
        'note', 'Attempt failed; refund remains owed and will be retried'
      ));

    RETURN jsonb_build_object('ok', true, 'issued', false, 'owed', true);
  END IF;

  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('refund_issued', p_payment_id,
    jsonb_build_object(
      'refund_id', p_refund_id,
      'amount', v_amount,
      'refund_status', v_status,
      'refund_reason', v_payment.refund_reason,
      'claim_attempt', v_attempt,
      'wallet_debit', CASE WHEN v_status = 'processed' THEN 'on_settlement' ELSE 'deferred' END
    ));

  -- Already settled at the provider: settle now (debit + close the debt).
  IF v_status = 'processed' THEN
    RETURN public.settle_payment_refund(p_payment_id, p_refund_id, 'processed', v_amount);
  END IF;

  -- Accepted but still in flight: persist the state and KEEP the debt.
  UPDATE public.payments
  SET status = 'refunded',
      refund_status = v_status,
      razorpay_refund_id = p_refund_id,
      refunded_amount = v_amount,
      refund_claim_state = 'issued',
      refund_claim_at = now(),
      refund_amount_due = COALESCE(v_payment.refund_amount_due, v_amount),
      updated_at = now()
  WHERE id = p_payment_id;

  IF p_refund_id IS NOT NULL THEN
    -- One row per refund cycle: reuse the unresolved row on a retry.
    UPDATE public.payment_refund_history
    SET razorpay_refund_id = p_refund_id,
        refund_status = v_status,
        amount = v_amount,
        updated_at = now()
    WHERE id = (
      SELECT h.id
      FROM public.payment_refund_history h
      WHERE h.payment_id = p_payment_id
        AND h.refund_status IN ('failed', 'pending', 'queued', 'requested')
        AND h.razorpay_refund_id IS DISTINCT FROM p_refund_id
      ORDER BY h.created_at DESC
      LIMIT 1
    );

    IF NOT FOUND THEN
      SELECT r.id, r.event_id INTO v_registration
      FROM public.registrations r
      WHERE r.id = v_payment.registration_id;

      IF FOUND THEN
        INSERT INTO public.payment_refund_history
          (payment_id, registration_id, event_id, amount, payment_amount, platform_fee,
           refund_status, razorpay_refund_id, refund_reason)
        VALUES
          (p_payment_id, v_registration.id, v_registration.event_id, v_amount,
           v_payment.amount, v_payment.platform_fee, v_status, p_refund_id, v_payment.refund_reason)
        ON CONFLICT (payment_id, razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL
        DO UPDATE SET refund_status = EXCLUDED.refund_status, updated_at = now();
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'issued', true,
    'payment_id', p_payment_id,
    'wallet_debited', false,
    'owed', true
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. settle_payment_refund — provider says the money reached the customer.
--    Closes the debt and debits the organizer share exactly once per cycle.
--    If the wallet is short, the customer refund still stands and the
--    clawback is marked pending for retry_refund_clawbacks().
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_payment_refund(
  p_payment_id UUID,
  p_refund_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT 'processed',
  p_amount INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment RECORD;
  v_registration RECORD;
  v_community_id UUID;
  v_status TEXT;
  v_amount INTEGER;
  v_attempt INTEGER;
  v_organizer_share INTEGER;
  v_debit JSONB;
BEGIN
  SELECT p.* INTO v_payment
  FROM public.payments p
  WHERE p.id = p_payment_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  v_status := COALESCE(NULLIF(p_status, ''), 'processed');
  v_amount := COALESCE(p_amount, v_payment.refunded_amount, v_payment.refund_amount_due, v_payment.amount);
  v_attempt := COALESCE(NULLIF(v_payment.refund_attempt_count, 0), 1);

  -- Non-terminal provider states: just sync status, never debit.
  IF v_status <> 'processed' THEN
    UPDATE public.payments
    SET refund_status = v_status,
        razorpay_refund_id = COALESCE(p_refund_id, razorpay_refund_id),
        refunded_amount = COALESCE(refunded_amount, v_amount),
        updated_at = now()
    WHERE id = p_payment_id;

    UPDATE public.payment_refund_history
    SET refund_status = v_status,
        updated_at = now()
    WHERE id = (
      SELECT h.id
      FROM public.payment_refund_history h
      WHERE h.payment_id = p_payment_id
        AND (h.razorpay_refund_id = p_refund_id OR h.refund_status IN ('pending', 'queued', 'requested', 'failed'))
      ORDER BY h.created_at DESC
      LIMIT 1
    );

    RETURN jsonb_build_object('ok', true, 'settled', false, 'refund_status', v_status, 'wallet_debited', false);
  END IF;

  -- Customer has been paid: close the customer debt.
  UPDATE public.payments
  SET status = 'refunded',
      refund_status = 'processed',
      razorpay_refund_id = COALESCE(p_refund_id, razorpay_refund_id),
      refunded_amount = v_amount,
      refund_amount_due = NULL,
      refund_claim_state = 'issued',
      refund_claim_at = COALESCE(refund_claim_at, now()),
      updated_at = now()
  WHERE id = p_payment_id;

  IF p_refund_id IS NOT NULL THEN
    UPDATE public.payment_refund_history
    SET razorpay_refund_id = p_refund_id,
        refund_status = 'processed',
        amount = v_amount,
        updated_at = now()
    WHERE id = (
      SELECT h.id
      FROM public.payment_refund_history h
      WHERE h.payment_id = p_payment_id
        AND (h.razorpay_refund_id = p_refund_id
             OR h.refund_status IN ('pending', 'queued', 'requested', 'failed'))
      ORDER BY h.created_at DESC
      LIMIT 1
    );

    IF NOT FOUND THEN
      SELECT r.id, r.event_id INTO v_registration
      FROM public.registrations r
      WHERE r.id = v_payment.registration_id;

      IF FOUND THEN
        INSERT INTO public.payment_refund_history
          (payment_id, registration_id, event_id, amount, payment_amount, platform_fee,
           refund_status, razorpay_refund_id, refund_reason)
        VALUES
          (p_payment_id, v_registration.id, v_registration.event_id, v_amount,
           v_payment.amount, v_payment.platform_fee, 'processed', p_refund_id, v_payment.refund_reason)
        ON CONFLICT (payment_id, razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL
        DO UPDATE SET refund_status = 'processed', updated_at = now();
      END IF;
    END IF;
  END IF;

  -- --------------------------------------------------------------------------
  -- Organizer clawback (exactly once per refund cycle)
  -- --------------------------------------------------------------------------
  SELECT r.id, r.event_id INTO v_registration
  FROM public.registrations r
  WHERE r.id = v_payment.registration_id;

  IF FOUND AND v_registration.event_id IS NOT NULL THEN
    SELECT e.community_id INTO v_community_id
    FROM public.events e
    WHERE e.id = v_registration.event_id;
  END IF;

  v_organizer_share := GREATEST(COALESCE(v_payment.organizer_share, 0), 0);

  -- Nothing was ever credited (never-confirmed sale): nothing to claw back.
  IF v_organizer_share <= 0 OR v_community_id IS NULL THEN
    UPDATE public.payments
    SET refund_clawback_state = 'done',
        refund_wallet_debited_attempt = v_attempt
    WHERE id = p_payment_id;

    RETURN jsonb_build_object(
      'ok', true, 'settled', true, 'wallet_debited', false,
      'refund_status', 'processed', 'clawback_state', 'done'
    );
  END IF;

  -- Already debited for this exact attempt (legacy issuance debit or a
  -- duplicate webhook): never debit twice.
  IF v_payment.refund_clawback_state = 'done'
     AND COALESCE(v_payment.refund_wallet_debited_attempt, 0) = v_attempt THEN
    RETURN jsonb_build_object(
      'ok', true, 'settled', true, 'wallet_debited', false,
      'already_debited', true, 'refund_status', 'processed', 'clawback_state', 'done'
    );
  END IF;

  SELECT * INTO v_debit
  FROM public.debit_wallet(
    v_community_id,
    v_organizer_share,
    COALESCE(NULLIF(v_payment.refund_reason, ''), p_refund_id, 'payment_refund'),
    v_registration.event_id,
    p_payment_id
  );

  IF COALESCE(v_debit->>'error', '') = '' THEN
    UPDATE public.payments
    SET refund_clawback_state = 'done',
        refund_wallet_debited_attempt = v_attempt
    WHERE id = p_payment_id;

    INSERT INTO public.payment_audit_log (action, payment_id, details)
    VALUES ('refund_clawback_settled', p_payment_id,
      jsonb_build_object(
        'refund_id', p_refund_id,
        'amount', v_organizer_share,
        'attempt', v_attempt,
        'new_balance', v_debit->>'new_balance'
      ));

    RETURN jsonb_build_object(
      'ok', true, 'settled', true, 'wallet_debited', true,
      'amount', v_organizer_share, 'refund_status', 'processed', 'clawback_state', 'done'
    );
  END IF;

  -- Wallet short: the customer is still refunded. Keep the organizer debt
  -- visible and retry once their wallet has money again.
  UPDATE public.payments
  SET refund_clawback_state = 'pending',
      refund_wallet_debited_attempt = 0
  WHERE id = p_payment_id;

  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('refund_wallet_debit_failed', p_payment_id,
    jsonb_build_object(
      'refund_id', p_refund_id,
      'amount', v_organizer_share,
      'attempt', v_attempt,
      'error', COALESCE(v_debit->>'error', 'Wallet debit failed'),
      'note', 'Customer refunded but organizer clawback is short — retry scheduled'
    ));

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_alerts a
    WHERE a.status = 'open'
      AND a.title = 'Refund clawback pending: organizer wallet short'
      AND a.details->>'payment_id' = p_payment_id::TEXT
  ) THEN
    INSERT INTO public.admin_alerts (severity, category, title, details)
    VALUES (
      'critical',
      'payment',
      'Refund clawback pending: organizer wallet short',
      jsonb_build_object(
        'payment_id', p_payment_id,
        'community_id', v_community_id,
        'event_id', v_registration.event_id,
        'amount', v_organizer_share,
        'refund_id', p_refund_id,
        'note', 'Customer was refunded, but the organizer wallet did not have enough balance. It will be retried automatically.'
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'settled', true, 'wallet_debited', false,
    'clawback_pending', true, 'refund_status', 'processed', 'clawback_state', 'pending'
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. retry_refund_clawbacks — retry shorts once the wallet is replenished.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retry_refund_clawbacks(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment RECORD;
  v_registration RECORD;
  v_community_id UUID;
  v_attempt INTEGER;
  v_debit JSONB;
  v_attempted INTEGER := 0;
  v_debited INTEGER := 0;
  v_pending INTEGER := 0;
BEGIN
  FOR v_payment IN
    SELECT p.*
    FROM public.payments p
    WHERE p.refund_clawback_state = 'pending'
      AND p.refund_status = 'processed'
      AND COALESCE(p.organizer_share, 0) > 0
    ORDER BY p.updated_at
    LIMIT GREATEST(COALESCE(p_limit, 50), 1)
    FOR UPDATE OF p SKIP LOCKED
  LOOP
    v_attempted := v_attempted + 1;
    v_attempt := COALESCE(NULLIF(v_payment.refund_attempt_count, 0), 1);

    SELECT r.id, r.event_id, e.community_id
    INTO v_registration
    FROM public.registrations r
    LEFT JOIN public.events e ON e.id = r.event_id
    WHERE r.id = v_payment.registration_id;

    IF NOT FOUND OR v_registration.community_id IS NULL THEN
      UPDATE public.payments
      SET refund_clawback_state = 'done',
          refund_wallet_debited_attempt = v_attempt
      WHERE id = v_payment.id;
      CONTINUE;
    END IF;

    v_community_id := v_registration.community_id;

    SELECT * INTO v_debit
    FROM public.debit_wallet(
      v_community_id,
      GREATEST(COALESCE(v_payment.organizer_share, 0), 0),
      COALESCE(NULLIF(v_payment.refund_reason, ''), 'payment_refund'),
      v_registration.event_id,
      v_payment.id
    );

    IF COALESCE(v_debit->>'error', '') = '' THEN
      UPDATE public.payments
      SET refund_clawback_state = 'done',
          refund_wallet_debited_attempt = v_attempt
      WHERE id = v_payment.id;

      INSERT INTO public.payment_audit_log (action, payment_id, details)
      VALUES ('refund_clawback_settled', v_payment.id,
        jsonb_build_object(
          'amount', v_payment.organizer_share,
          'attempt', v_attempt,
          'new_balance', v_debit->>'new_balance',
          'source', 'retry_refund_clawbacks'
        ));

      v_debited := v_debited + 1;
    ELSE
      v_pending := v_pending + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'attempted', v_attempted,
    'debited', v_debited,
    'pending', v_pending
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Grants — money RPCs are service_role only.
-- ----------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON FUNCTION public.claim_payment_refund(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_refund(UUID, TEXT, INTEGER) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.complete_payment_refund(UUID, BOOLEAN, TEXT, TEXT, INTEGER, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_payment_refund(UUID, BOOLEAN, TEXT, TEXT, INTEGER, TEXT, BOOLEAN) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.settle_payment_refund(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_payment_refund(UUID, TEXT, TEXT, INTEGER) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.retry_refund_clawbacks(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_refund_clawbacks(INTEGER) TO service_role;
