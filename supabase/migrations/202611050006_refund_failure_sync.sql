-- ============================================================================
-- Refinement: provider-failure webhooks must be accepted for an issued but
-- still-in-flight refund, and settle must refuse a payment with no refund.
-- ============================================================================

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

  -- Allow: a live claim, a retry of a failed attempt, a failure reported by
  -- the provider for an accepted-but-unsettled refund, or a processed
  -- adoption record. Never a fresh issue on a terminal refund.
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

  -- Never settle a payment that is not part of a refund flow at all.
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

  SELECT r.id, r.event_id INTO v_registration
  FROM public.registrations r
  WHERE r.id = v_payment.registration_id;

  IF FOUND AND v_registration.event_id IS NOT NULL THEN
    SELECT e.community_id INTO v_community_id
    FROM public.events e
    WHERE e.id = v_registration.event_id;
  END IF;

  v_organizer_share := GREATEST(COALESCE(v_payment.organizer_share, 0), 0);

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

REVOKE ALL PRIVILEGES ON FUNCTION public.complete_payment_refund(UUID, BOOLEAN, TEXT, TEXT, INTEGER, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_payment_refund(UUID, BOOLEAN, TEXT, TEXT, INTEGER, TEXT, BOOLEAN) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.settle_payment_refund(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_payment_refund(UUID, TEXT, TEXT, INTEGER) TO service_role;
