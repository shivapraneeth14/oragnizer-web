-- ============================================================================
-- CLUVO STAGE 6 REMEDIATION — MIGRATION 16:
-- REF-004: Cryptographic Ticket Token Generation with COALESCE Non-Rotation
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_payment(
  p_payment_id UUID,
  p_expected_amount INTEGER DEFAULT NULL,
  p_expected_currency TEXT DEFAULT 'INR',
  p_razorpay_payment_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment RECORD;
  v_reg RECORD;
  v_event RECORD;
  v_community RECORD;
  v_updated INTEGER;
  v_platform_fee INTEGER;
  v_platform_fee_gst INTEGER;
  v_organizer_share INTEGER;
  v_reg_id UUID;
  v_event_id UUID;
BEGIN
  -- Set transaction lock timeout to avoid indefinite queuing
  SET LOCAL lock_timeout = '3s';

  -- Step 0: Non-locking lookup to determine foreign key hierarchy
  SELECT p.registration_id, r.event_id
  INTO v_reg_id, v_event_id
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  WHERE p.id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment or registration not found');
  END IF;

  -- Level 1: Lock Event Row FIRST
  SELECT * INTO v_event
  FROM public.events
  WHERE id = v_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Event not found');
  END IF;

  -- Level 2: Lock Registration Row SECOND
  SELECT * INTO v_reg
  FROM public.registrations
  WHERE id = v_reg_id
  FOR UPDATE;

  -- Level 3: Lock Payment Row THIRD
  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  -- Record provider payment ID if provided
  IF p_razorpay_payment_id IS NOT NULL AND v_payment.razorpay_payment_id IS NULL THEN
    UPDATE public.payments
    SET razorpay_payment_id = p_razorpay_payment_id
    WHERE id = p_payment_id;
    v_payment.razorpay_payment_id := p_razorpay_payment_id;
  END IF;

  -- Security Validations (PAY-SEC-004)
  IF p_expected_amount IS NOT NULL AND v_payment.amount != p_expected_amount THEN
    RETURN jsonb_build_object('error', 'Amount mismatch', 'code', 400);
  END IF;

  IF p_expected_currency IS NOT NULL AND v_payment.currency != p_expected_currency THEN
    RETURN jsonb_build_object('error', 'Currency mismatch', 'code', 400);
  END IF;

  -- Idempotency: Already confirmed or refunded
  IF v_payment.status IN ('success', 'refunded') THEN
    RETURN jsonb_build_object('skipped', true, 'payment_id', p_payment_id);
  END IF;

  -- Guard: Cancelled registration
  IF v_reg.status = 'cancelled' THEN
    UPDATE public.payments
    SET status = 'failed',
        failure_reason = 'registration_cancelled',
        refund_reason = COALESCE(refund_reason, 'registration_cancellation')
    WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id, 'reason', 'registration_cancellation');
  END IF;

  -- Guard: Cancelled or Cancelling Event
  IF v_event.status IN ('cancelled', 'cancelling') THEN
    UPDATE public.payments
    SET status = 'failed',
        failure_reason = 'event_cancelled',
        refund_reason = COALESCE(refund_reason, 'event_cancellation')
    WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id, 'reason', 'event_cancellation');
  END IF;

  -- Atomic Capacity Increment
  UPDATE public.events e SET booked_count = booked_count + 1
  WHERE e.id = v_event.id
    AND (e.capacity IS NULL OR e.booked_count < e.capacity);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    UPDATE public.payments
    SET status = 'failed',
        failure_reason = 'capacity_full',
        refund_reason = COALESCE(refund_reason, 'capacity_full')
    WHERE id = p_payment_id;

    UPDATE public.registrations
    SET status = 'cancelled',
        hold_expires_at = NULL
    WHERE id = v_reg_id;

    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id, 'reason', 'capacity_full');
  END IF;

  -- Fee and Split Math
  v_platform_fee := GREATEST(COALESCE(v_payment.platform_fee, 0), 0);
  v_platform_fee_gst := GREATEST(COALESCE(v_payment.platform_fee_gst, 0), 0);
  v_organizer_share := GREATEST(v_payment.amount - v_platform_fee, 0);

  UPDATE public.payments
  SET status = 'success',
      platform_fee = v_platform_fee,
      platform_fee_gst = v_platform_fee_gst,
      organizer_share = v_organizer_share,
      failure_reason = NULL,
      updated_at = clock_timestamp()
  WHERE id = p_payment_id;

  -- REF-004: Dual-UUID compound CSPRNG token (244 bits true entropy) with COALESCE non-rotation
  UPDATE public.registrations
  SET status = 'confirmed',
      hold_expires_at = NULL,
      qr_code = COALESCE(
        v_reg.qr_code,
        'cluvo_' || encode(sha256((gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text)::bytea), 'hex')
      ),
      updated_at = clock_timestamp()
  WHERE id = v_reg_id;

  -- Level 4: Wallet Credit
  SELECT * INTO v_community FROM public.communities WHERE id = v_event.community_id;
  PERFORM public.credit_wallet(v_community.id, v_organizer_share, v_event.id);

  IF v_reg.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, title, body, type)
    VALUES (
      v_reg.user_id,
      'Booking Confirmed!',
      'Your ticket for "' || v_event.title || '" is confirmed.',
      'booking'
    );
  END IF;

  RETURN jsonb_build_object('action', 'confirmed', 'payment_id', p_payment_id);
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_payment(UUID, INTEGER, TEXT, TEXT) TO service_role;

