-- ----------------------------------------------------------------------------
-- Atomic customer self-cancellation + refund claim.
--
-- Cancels the registration, releases capacity exactly once, and persists the
-- refund debt/claim in one transaction. Without this, a crash between
-- "cancel ticket" and "start refund" left the customer cancelled with no debt.
--
-- Owner-only. Attended tickets stay non-refundable. Idempotent: a second call
-- for an already-cancelled registration returns the current refund state
-- instead of failing, so a double tap can never cancel twice or refund twice.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_cancel_registration_and_claim_refund(
  p_payment_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reg_id UUID;
  v_event_id UUID;
  v_event_start TIMESTAMPTZ;
  v_event_status TEXT;
  v_reg_user_id UUID;
  v_reg_status TEXT;
  v_community_id UUID;
  v_payment RECORD;
  v_booked_count_decremented BOOLEAN := FALSE;
  v_refund_due INTEGER;
BEGIN
  -- Step 0: identify the payment/registration/event and verify ownership.
  SELECT p.registration_id, r.event_id, r.user_id, e.community_id
  INTO v_reg_id, v_event_id, v_reg_user_id, v_community_id
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  LEFT JOIN public.events e ON e.id = r.event_id
  WHERE p.id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment or registration not found');
  END IF;

  IF v_reg_user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('error', 'Unauthorized: Not the registration owner');
  END IF;

  -- Step 1: Lock hierarchy Level 1 - event row.
  IF v_event_id IS NOT NULL THEN
    SELECT e.status, e.start_date
    INTO v_event_status, v_event_start
    FROM public.events e
    WHERE e.id = v_event_id
    FOR UPDATE;

    IF v_event_status = 'cancelled' THEN
      RETURN jsonb_build_object(
        'error', 'event_cancelled',
        'message', 'Event has been cancelled'
      );
    END IF;
  END IF;

  -- Step 2: Lock hierarchy Level 2 - registration row.
  SELECT r.status INTO v_reg_status
  FROM public.registrations r
  WHERE r.id = v_reg_id
  FOR UPDATE;

  IF v_reg_status = 'attended' THEN
    RETURN jsonb_build_object(
      'error', 'not_refundable_attended',
      'message', 'Attendee already attended the event - no refund'
    );
  END IF;

  -- Step 3: Lock hierarchy Level 3 - payment row.
  SELECT * INTO v_payment
  FROM public.payments p
  WHERE p.id = p_payment_id
  FOR UPDATE;

  -- Idempotent double-tap: return the live state, never cancel/refund twice.
  IF v_reg_status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_cancelled', true,
      'payment_id', p_payment_id,
      'registration_id', v_reg_id,
      'amount', COALESCE(v_payment.refund_amount_due, v_payment.refunded_amount, 0),
      'refund_status', v_payment.refund_status,
      'refund_claim_state', v_payment.refund_claim_state,
      'razorpay_refund_id', v_payment.razorpay_refund_id,
      'decremented_capacity', FALSE
    );
  END IF;

  IF v_payment.status NOT IN ('success', 'failed')
     OR v_payment.razorpay_payment_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Payment is not refundable in its current state');
  END IF;

  -- A live provider refund already exists - do not start a second one.
  IF v_payment.refund_claim_state = 'issued'
     AND v_payment.refund_status IN ('requested', 'pending', 'queued', 'approved', 'processed') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_refunded', true,
      'payment_id', p_payment_id,
      'registration_id', v_reg_id,
      'amount', COALESCE(v_payment.refund_amount_due, v_payment.refunded_amount, 0),
      'refund_status', v_payment.refund_status,
      'razorpay_refund_id', v_payment.razorpay_refund_id,
      'decremented_capacity', FALSE
    );
  END IF;

  -- Persisted customer debt: ticket price only (platform fee is kept on a
  -- self-cancel). Never overwrite an amount recorded by an earlier claim.
  v_refund_due := COALESCE(
    v_payment.refund_amount_due,
    GREATEST(COALESCE(v_payment.amount, 0) - COALESCE(v_payment.platform_fee, 0), 0)
  );

  -- Step 4: cancel the ticket and clear its QR immediately.
  UPDATE public.registrations
  SET status = 'cancelled',
      qr_code = NULL,
      deleted_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = v_reg_id;

  -- Exactly-once capacity release (only a confirmed registration occupied it).
  IF v_reg_status = 'confirmed' AND v_event_id IS NOT NULL THEN
    UPDATE public.events
    SET booked_count = GREATEST(0, COALESCE(booked_count, 0) - 1),
        updated_at = clock_timestamp()
    WHERE id = v_event_id;
    v_booked_count_decremented := TRUE;
  END IF;

  -- Step 5: persist the refund debt + claim in the same transaction.
  UPDATE public.payments
  SET refund_claim_state = 'claimed',
      refund_claim_at = clock_timestamp(),
      refund_attempt_count = COALESCE(refund_attempt_count, 0) + 1,
      refund_reason = 'registration_cancellation',
      refund_amount_due = v_refund_due,
      refund_status = CASE WHEN refund_status = 'failed' THEN NULL ELSE refund_status END,
      refund_clawback_state = CASE
        WHEN refund_status = 'failed' THEN refund_clawback_state
        ELSE 'pending'
      END,
      refund_wallet_debited_attempt = CASE
        WHEN refund_status = 'failed' THEN refund_wallet_debited_attempt
        ELSE 0
      END,
      updated_at = clock_timestamp()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'ok', true,
    'payment_id', p_payment_id,
    'registration_id', v_reg_id,
    'event_id', v_event_id,
    'community_id', v_community_id,
    'amount', v_refund_due,
    'payment_amount', v_payment.amount,
    'platform_fee', v_payment.platform_fee,
    'razorpay_payment_id', v_payment.razorpay_payment_id,
    'claim_attempt', COALESCE(v_payment.refund_attempt_count, 0) + 1,
    'decremented_capacity', v_booked_count_decremented
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.customer_cancel_registration_and_claim_refund(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_cancel_registration_and_claim_refund(UUID, UUID) TO service_role;
