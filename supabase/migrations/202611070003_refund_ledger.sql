-- ============================================================================
-- CLUVO — Refund settlement writes the durable ledger
--
-- Changes:
--   1. Every refund row is linked to the SALE it reverses (sale_id) and stores
--      the amounts that matter (refund_amount, fee_kept, organizer_clawed).
--   2. The organizer clawback is recorded in refund_clawbacks BEFORE the
--      wallet debit is attempted. A failed/short debit leaves a durable debt
--      row that a requote cannot erase.
--   3. The clawback amount comes from the sale snapshot, not from the mutable
--      `payments.organizer_share` (which points at the LATEST sale after a
--      rebook).
--   4. `payments.refund_clawback_state` is kept in sync for compatibility with
--      every existing reader; `refund_clawbacks` becomes authoritative.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Pick the sale a refund is reversing.
--    Prefer the sale matching the payment's current capture id, then the most
--    recent sale. Refunds are attached at refund time, before any requote can
--    change the capture id.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_sale_id(p_payment_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.id
  FROM public.payment_sales s
  JOIN public.payments p ON p.id = s.payment_id
  WHERE s.payment_id = p_payment_id
  ORDER BY (s.razorpay_payment_id = p.razorpay_payment_id) DESC,
           s.captured_at DESC
  LIMIT 1;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.current_sale_id(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_sale_id(uuid) TO service_role;

-- ----------------------------------------------------------------------------
-- 1. complete_payment_refund
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
  v_sale RECORD;
  v_status TEXT;
  v_amount INTEGER;
  v_attempt INTEGER;
  v_refund_row_id UUID;
  v_organizer_clawed INTEGER;
  v_fee_kept INTEGER;
BEGIN
  SELECT p.* INTO v_payment
  FROM public.payments p
  WHERE p.id = p_payment_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  v_status := COALESCE(NULLIF(p_status, ''), 'pending');

  IF NOT (
    v_payment.refund_claim_state IN ('claimed', 'failed')
    OR (NOT p_success AND v_payment.refund_claim_state = 'issued'
        AND COALESCE(v_payment.refund_status, '') IN ('pending', 'queued', 'requested', 'approved'))
    OR (v_status = 'processed' AND v_payment.refund_claim_state = 'issued')
    OR v_payment.refund_status = 'failed'
  ) THEN
    RETURN jsonb_build_object('error', 'No live refund claim for this payment');
  END IF;

  v_amount := COALESCE(p_amount, v_payment.refund_amount_due, v_payment.refunded_amount, v_payment.amount);
  v_attempt := COALESCE(NULLIF(v_payment.refund_attempt_count, 0), 1);

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

  -- Snapshot the sale this refund reverses (may be NULL for a legacy row).
  SELECT s.* INTO v_sale
  FROM public.payment_sales s
  WHERE s.id = public.current_sale_id(p_payment_id);

  SELECT r.id, r.event_id INTO v_registration
  FROM public.registrations r
  WHERE r.id = v_payment.registration_id;

  v_organizer_clawed := LEAST(
    GREATEST(v_amount, 0),
    GREATEST(COALESCE(v_sale.ticket_amount, v_payment.organizer_share, 0), 0)
  );
  v_fee_kept := CASE
    WHEN COALESCE(v_payment.refund_reason, '') = 'registration_cancellation'
      THEN GREATEST(COALESCE(v_sale.platform_fee, v_payment.platform_fee, 0), 0)
    ELSE 0
  END;

  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('refund_issued', p_payment_id,
    jsonb_build_object(
      'refund_id', p_refund_id,
      'amount', v_amount,
      'refund_status', v_status,
      'refund_reason', v_payment.refund_reason,
      'claim_attempt', v_attempt,
      'sale_id', v_sale.id,
      'organizer_clawed', v_organizer_clawed,
      'wallet_debit', CASE WHEN v_status = 'processed' THEN 'on_settlement' ELSE 'deferred' END
    ));

  IF v_status = 'processed' THEN
    RETURN public.settle_payment_refund(p_payment_id, p_refund_id, 'processed', v_amount);
  END IF;

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
    UPDATE public.payment_refund_history
    SET razorpay_refund_id = p_refund_id,
        refund_status = v_status,
        amount = v_amount,
        refund_amount = v_amount,
        sale_id = COALESCE(sale_id, v_sale.id),
        community_id = COALESCE(community_id, v_sale.community_id),
        organizer_clawed = CASE WHEN organizer_clawed = 0 THEN v_organizer_clawed ELSE organizer_clawed END,
        fee_kept = CASE WHEN fee_kept = 0 THEN v_fee_kept ELSE fee_kept END,
        requested_at = COALESCE(requested_at, now()),
        updated_at = now()
    WHERE id = (
      SELECT h.id
      FROM public.payment_refund_history h
      WHERE h.payment_id = p_payment_id
        AND h.refund_status IN ('failed', 'pending', 'queued', 'requested')
        AND h.razorpay_refund_id IS DISTINCT FROM p_refund_id
      ORDER BY h.created_at DESC
      LIMIT 1
    )
    RETURNING id INTO v_refund_row_id;

    IF v_refund_row_id IS NULL AND v_registration.id IS NOT NULL THEN
      INSERT INTO public.payment_refund_history
        (payment_id, registration_id, event_id, amount, payment_amount, platform_fee,
         refund_status, razorpay_refund_id, refund_reason,
         sale_id, community_id, refund_amount, fee_kept, organizer_clawed,
         requested_at, currency, source)
      VALUES
        (p_payment_id, v_registration.id, v_registration.event_id, v_amount,
         COALESCE(v_sale.gross_amount, v_payment.amount),
         COALESCE(v_sale.platform_fee, v_payment.platform_fee),
         v_status, p_refund_id, v_payment.refund_reason,
         v_sale.id, COALESCE(v_sale.community_id, (SELECT e.community_id FROM public.events e WHERE e.id = v_registration.event_id)),
         v_amount, v_fee_kept, v_organizer_clawed,
         now(), COALESCE(v_sale.currency, v_payment.currency, 'INR'), 'live')
      ON CONFLICT (payment_id, razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL
      DO UPDATE SET refund_status = EXCLUDED.refund_status, updated_at = now()
      RETURNING id INTO v_refund_row_id;
    END IF;

    IF v_refund_row_id IS NOT NULL AND v_organizer_clawed > 0 AND v_sale.id IS NOT NULL THEN
      INSERT INTO public.refund_clawbacks (
        refund_id, payment_id, sale_id, community_id, event_id, amount, state, created_at
      )
      VALUES (
        v_refund_row_id, p_payment_id, v_sale.id,
        COALESCE(v_sale.community_id, (SELECT e.community_id FROM public.events e WHERE e.id = v_registration.event_id)),
        v_registration.event_id, v_organizer_clawed, 'pending', now()
      )
      ON CONFLICT (refund_id) DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'issued', true,
    'payment_id', p_payment_id,
    'sale_id', v_sale.id,
    'wallet_debited', false,
    'owed', true
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. settle_payment_refund
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
  v_sale RECORD;
  v_refund RECORD;
  v_clawback RECORD;
  v_community_id UUID;
  v_status TEXT;
  v_amount INTEGER;
  v_attempt INTEGER;
  v_organizer_share INTEGER;
  v_debit JSONB;
  v_refund_row_id UUID;
BEGIN
  SELECT p.* INTO v_payment
  FROM public.payments p
  WHERE p.id = p_payment_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  IF v_payment.refund_claim_state = 'none'
     AND COALESCE(v_payment.refund_status, '') = ''
     AND v_payment.razorpay_refund_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.payment_audit_log pal
       WHERE pal.payment_id = v_payment.id
         AND pal.action IN ('refund_issued', 'refund_status_synced')
     ) THEN
    RETURN jsonb_build_object('error', 'No refund to settle for this payment');
  END IF;

  v_status := COALESCE(NULLIF(p_status, ''), 'processed');
  v_amount := COALESCE(p_amount, v_payment.refunded_amount, v_payment.refund_amount_due, v_payment.amount);
  v_attempt := COALESCE(NULLIF(v_payment.refund_attempt_count, 0), 1);

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

  -- Find (or create) the refund ledger row for this settlement.
  SELECT h.* INTO v_refund
  FROM public.payment_refund_history h
  WHERE h.payment_id = p_payment_id
    AND (
      (p_refund_id IS NOT NULL AND h.razorpay_refund_id = p_refund_id)
      OR (p_refund_id IS NULL AND h.refund_status IN ('pending', 'queued', 'requested', 'failed'))
    )
  ORDER BY h.created_at DESC
  LIMIT 1;

  IF p_refund_id IS NOT NULL THEN
    UPDATE public.payment_refund_history
    SET razorpay_refund_id = p_refund_id,
        refund_status = 'processed',
        amount = v_amount,
        refund_amount = COALESCE(refund_amount, v_amount),
        processed_at = COALESCE(processed_at, now()),
        updated_at = now()
    WHERE id = v_refund.id
    RETURNING id INTO v_refund_row_id;

    IF v_refund_row_id IS NULL THEN
      SELECT r.id, r.event_id, e.community_id INTO v_registration
      FROM public.registrations r
      LEFT JOIN public.events e ON e.id = r.event_id
      WHERE r.id = v_payment.registration_id;

      IF FOUND THEN
        SELECT s.* INTO v_sale
        FROM public.payment_sales s
        WHERE s.id = public.current_sale_id(p_payment_id);

        INSERT INTO public.payment_refund_history
          (payment_id, registration_id, event_id, amount, payment_amount, platform_fee,
           refund_status, razorpay_refund_id, refund_reason,
           sale_id, community_id, refund_amount, fee_kept, organizer_clawed,
           requested_at, processed_at, currency, source)
        VALUES
          (p_payment_id, v_registration.id, v_registration.event_id, v_amount,
           COALESCE(v_sale.gross_amount, v_payment.amount),
           COALESCE(v_sale.platform_fee, v_payment.platform_fee),
           'processed', p_refund_id, v_payment.refund_reason,
           v_sale.id, v_registration.community_id, v_amount,
           CASE WHEN COALESCE(v_payment.refund_reason, '') = 'registration_cancellation'
                THEN GREATEST(COALESCE(v_sale.platform_fee, v_payment.platform_fee, 0), 0)
                ELSE 0 END,
           LEAST(v_amount, GREATEST(COALESCE(v_sale.ticket_amount, v_payment.organizer_share, 0), 0)),
           now(), now(), COALESCE(v_sale.currency, v_payment.currency, 'INR'), 'live')
        ON CONFLICT (payment_id, razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL
        DO UPDATE SET refund_status = 'processed', updated_at = now()
        RETURNING id INTO v_refund_row_id;
      END IF;
    END IF;
  END IF;

  IF v_refund_row_id IS NULL THEN
    v_refund_row_id := v_refund.id;
  END IF;

  IF v_refund_row_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'settled', true, 'wallet_debited', false,
                              'refund_status', 'processed', 'clawback_state', 'done');
  END IF;

  -- Snapshot the sale and the amount that must come back from the organizer.
  SELECT h.* INTO v_refund
  FROM public.payment_refund_history h
  WHERE h.id = v_refund_row_id;

  IF v_refund.sale_id IS NOT NULL THEN
    SELECT s.* INTO v_sale FROM public.payment_sales s WHERE s.id = v_refund.sale_id;
  ELSE
    SELECT s.* INTO v_sale
    FROM public.payment_sales s
    WHERE s.id = public.current_sale_id(p_payment_id);
  END IF;

  v_organizer_share := COALESCE(
    NULLIF(v_refund.organizer_clawed, 0),
    LEAST(v_refund.amount, COALESCE(v_sale.ticket_amount, v_payment.organizer_share, 0)),
    0
  );

  SELECT r.id, r.event_id, e.community_id INTO v_registration
  FROM public.registrations r
  LEFT JOIN public.events e ON e.id = r.event_id
  WHERE r.id = v_payment.registration_id;

  v_community_id := COALESCE(v_sale.community_id, v_registration.community_id);

  IF v_organizer_share <= 0 OR v_community_id IS NULL OR v_sale.id IS NULL THEN
    UPDATE public.payments
    SET refund_clawback_state = 'done',
        refund_wallet_debited_attempt = v_attempt
    WHERE id = p_payment_id;

    RETURN jsonb_build_object(
      'ok', true, 'settled', true, 'wallet_debited', false,
      'refund_status', 'processed', 'clawback_state', 'done'
    );
  END IF;

  -- The durable debt row. Created here even when the wallet is short, and
  -- never deleted or reset by a later requote.
  INSERT INTO public.refund_clawbacks (
    refund_id, payment_id, sale_id, community_id, event_id, amount, state, created_at
  )
  VALUES (
    v_refund_row_id, p_payment_id, v_sale.id, v_community_id,
    v_registration.event_id, v_organizer_share, 'pending', now()
  )
  ON CONFLICT (refund_id) DO NOTHING;

  SELECT * INTO v_clawback
  FROM public.refund_clawbacks
  WHERE refund_id = v_refund_row_id
  FOR UPDATE;

  IF v_clawback.state = 'done' THEN
    UPDATE public.payments
    SET refund_clawback_state = 'done',
        refund_wallet_debited_attempt = v_attempt
    WHERE id = p_payment_id;

    RETURN jsonb_build_object(
      'ok', true, 'settled', true, 'wallet_debited', false,
      'already_debited', true, 'refund_status', 'processed', 'clawback_state', 'done'
    );
  END IF;

  SELECT * INTO v_debit
  FROM public.debit_wallet(
    v_community_id,
    v_clawback.amount,
    COALESCE(NULLIF(v_payment.refund_reason, ''), p_refund_id, 'payment_refund'),
    v_registration.event_id,
    p_payment_id
  );

  IF COALESCE(v_debit->>'error', '') = '' THEN
    UPDATE public.refund_clawbacks
    SET state = 'done',
        attempts = attempts + 1,
        last_error = NULL,
        settled_at = clock_timestamp()
    WHERE id = v_clawback.id;

    UPDATE public.payments
    SET refund_clawback_state = 'done',
        refund_wallet_debited_attempt = v_attempt
    WHERE id = p_payment_id;

    INSERT INTO public.payment_audit_log (action, payment_id, details)
    VALUES ('refund_clawback_settled', p_payment_id,
      jsonb_build_object(
        'refund_id', p_refund_id,
        'amount', v_clawback.amount,
        'attempt', v_attempt,
        'sale_id', v_sale.id,
        'new_balance', v_debit->>'new_balance'
      ));

    RETURN jsonb_build_object(
      'ok', true, 'settled', true, 'wallet_debited', true,
      'amount', v_clawback.amount, 'refund_status', 'processed', 'clawback_state', 'done'
    );
  END IF;

  UPDATE public.refund_clawbacks
  SET attempts = attempts + 1,
      last_error = COALESCE(v_debit->>'error', 'Wallet debit failed')
  WHERE id = v_clawback.id;

  UPDATE public.payments
  SET refund_clawback_state = 'pending',
      refund_wallet_debited_attempt = 0
  WHERE id = p_payment_id;

  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('refund_wallet_debit_failed', p_payment_id,
    jsonb_build_object(
      'refund_id', p_refund_id,
      'amount', v_clawback.amount,
      'attempt', v_attempt,
      'sale_id', v_sale.id,
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
        'amount', v_clawback.amount,
        'refund_id', p_refund_id,
        'sale_id', v_sale.id,
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
-- 3. retry_refund_clawbacks — reads the durable debt table
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retry_refund_clawbacks(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cb RECORD;
  v_registration RECORD;
  v_debit JSONB;
  v_attempted INTEGER := 0;
  v_debited INTEGER := 0;
  v_pending INTEGER := 0;
BEGIN
  FOR v_cb IN
    SELECT *
    FROM public.refund_clawbacks
    WHERE state = 'pending'
    ORDER BY created_at
    LIMIT GREATEST(COALESCE(p_limit, 50), 1)
    FOR UPDATE SKIP LOCKED
  LOOP
    v_attempted := v_attempted + 1;

    SELECT r.id, r.event_id INTO v_registration
    FROM public.registrations r
    WHERE r.id = (SELECT registration_id FROM public.payments WHERE id = v_cb.payment_id);

    SELECT * INTO v_debit
    FROM public.debit_wallet(
      v_cb.community_id,
      v_cb.amount,
      'payment_refund',
      v_cb.event_id,
      v_cb.payment_id
    );

    IF COALESCE(v_debit->>'error', '') = '' THEN
      UPDATE public.refund_clawbacks
      SET state = 'done',
          attempts = attempts + 1,
          last_error = NULL,
          settled_at = clock_timestamp()
      WHERE id = v_cb.id;

      UPDATE public.payments
      SET refund_clawback_state = 'done',
          refund_wallet_debited_attempt = GREATEST(COALESCE(refund_attempt_count, 0), 1)
      WHERE id = v_cb.payment_id;

      INSERT INTO public.payment_audit_log (action, payment_id, details)
      VALUES ('refund_clawback_settled', v_cb.payment_id,
        jsonb_build_object(
          'amount', v_cb.amount,
          'sale_id', v_cb.sale_id,
          'clawback_id', v_cb.id,
          'new_balance', v_debit->>'new_balance',
          'source', 'retry_refund_clawbacks'
        ));

      v_debited := v_debited + 1;
    ELSE
      UPDATE public.refund_clawbacks
      SET attempts = attempts + 1,
          last_error = COALESCE(v_debit->>'error', 'Wallet debit failed')
      WHERE id = v_cb.id;
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

REVOKE ALL PRIVILEGES ON FUNCTION public.complete_payment_refund(UUID, BOOLEAN, TEXT, TEXT, INTEGER, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_payment_refund(UUID, BOOLEAN, TEXT, TEXT, INTEGER, TEXT, BOOLEAN) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.settle_payment_refund(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_payment_refund(UUID, TEXT, TEXT, INTEGER) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.retry_refund_clawbacks(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_refund_clawbacks(INTEGER) TO service_role;
