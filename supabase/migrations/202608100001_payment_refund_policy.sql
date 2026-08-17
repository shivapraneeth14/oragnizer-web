-- ============================================================================
-- CLUVO - PAYMENT REFUND POLICY (2026-08-10)
--
-- 1. confirm_payment: refuse to confirm on a cancelled event -> refund_required
--    (closes the pay-during-cancel race; webhook auto-refunds)
-- 2. payments.refund_status: widen check to include real Razorpay refund
--    statuses (pending/failed/queued) - webhook + API now store the truth
-- 3. payments.refund_attempt_count: track failed refund attempts (retry job
--    in reconcile-payments caps at 5, then a distinct refund_retry_exhausted
--    audit action flags manual follow-up)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 2. Widen refund_status check
-- ---------------------------------------------------------------------------
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_refund_status_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_refund_status_check
  CHECK (refund_status IN ('requested','approved','processed','denied','pending','failed','queued'));

-- ---------------------------------------------------------------------------
-- 3. Refund attempt counter
-- ---------------------------------------------------------------------------
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refund_attempt_count INT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 1. confirm_payment - cancelled-event guard
--    (canonical version: 202607300015_remove_route_transfers.sql + guard)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION confirm_payment(p_payment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment RECORD;
  v_event RECORD;
  v_community RECORD;
  v_coupon RECORD;
  v_base_amount INTEGER;
  v_discount INTEGER;
  v_platform_fee INTEGER;
  v_organizer_share INTEGER;
  v_updated INTEGER;
BEGIN
  SELECT p.*, r.event_id, r.user_id, r.status AS reg_status
  INTO v_payment
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  WHERE p.id = p_payment_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  IF v_payment.status = 'success' THEN
    RETURN jsonb_build_object('skipped', true, 'payment_id', p_payment_id);
  END IF;

  SELECT e.* INTO v_event FROM public.events e WHERE e.id = v_payment.event_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Event not found');
  END IF;

  -- Cancelled-event guard: never confirm a payment on a cancelled event.
  -- The customer gets their money back instead (webhook routes
  -- refund_required to processRefund).
  IF v_event.status = 'cancelled' THEN
    UPDATE public.payments SET status = 'failed' WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id,
      'reason', 'event_cancelled');
  END IF;

  SELECT c.* INTO v_community FROM public.communities c WHERE c.id = v_event.community_id;

  UPDATE public.events e SET booked_count = booked_count + 1
  WHERE e.id = v_event.id
    AND (e.capacity IS NULL OR e.booked_count < e.capacity);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    UPDATE public.payments SET status = 'failed' WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id);
  END IF;

  v_base_amount := v_payment.amount;
  v_discount := 0;

  IF v_payment.coupon_id IS NOT NULL THEN
    SELECT * INTO v_coupon FROM public.coupons WHERE id = v_payment.coupon_id;
    IF FOUND THEN
      IF v_coupon.discount_type = 'percentage' THEN
        v_discount := (v_payment.amount * v_coupon.discount_value / 100)::INTEGER;
      ELSE
        v_discount := v_coupon.discount_value;
      END IF;
    END IF;
  END IF;

  IF v_community.commission_on = 'post_discount' THEN
    v_base_amount := v_payment.amount - v_discount;
  END IF;

  v_platform_fee := (v_base_amount * v_community.commission_percent / 100)::INTEGER;
  v_organizer_share := v_base_amount - v_platform_fee;

  UPDATE public.payments SET status = 'success' WHERE id = p_payment_id;
  UPDATE public.registrations
  SET status = 'confirmed',
      qr_code = encode(
        sha256(
          (p_payment_id::text || v_event.id::text || v_payment.registration_id::text)::bytea
        ),
        'hex'
      )
  WHERE id = v_payment.registration_id;

  PERFORM public.credit_wallet(v_community.id, v_organizer_share);

  INSERT INTO public.notifications (user_id, type, title, body, payload)
  VALUES (
    v_payment.user_id,
    'registration_confirmed',
    'Registration Confirmed',
    'Your registration for "' || v_event.title || '" has been confirmed.',
    jsonb_build_object(
      'event_id', v_event.id,
      'registration_id', v_payment.registration_id,
      'payment_id', p_payment_id,
      'amount', v_payment.amount
    )
  );

  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('payment_confirmed', p_payment_id,
    jsonb_build_object('event_id', v_event.id, 'amount', v_payment.amount,
      'organizer_share', v_organizer_share, 'platform_fee', v_platform_fee,
      'commission_on', v_community.commission_on, 'discount', v_discount));

  RETURN jsonb_build_object(
    'action', 'confirmed',
    'payment_id', p_payment_id,
    'organizer_share', v_organizer_share,
    'platform_fee', v_platform_fee,
    'commission_on', v_community.commission_on,
    'discount', v_discount
  );
END;
$$;