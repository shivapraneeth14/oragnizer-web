-- ============================================================================
-- Item 9: commission_on wiring — use community.commission_on to determine
--   whether commission is calculated on pre-discount or post-discount amount
-- Item 10: coupon confirmation — increment coupons.used_count on successful payment
-- ============================================================================

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
  v_transfer_id UUID;
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

  SELECT c.* INTO v_community FROM public.communities c WHERE c.id = v_event.community_id;

  UPDATE public.events e SET booked_count = booked_count + 1
  WHERE e.id = v_event.id
    AND (e.capacity IS NULL OR e.booked_count < e.capacity);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    UPDATE public.payments SET status = 'failed' WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id);
  END IF;

  -- Determine base amount for commission calculation (Item 9)
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

  -- Increment coupon used_count (Item 10)
  IF v_payment.coupon_id IS NOT NULL THEN
    UPDATE public.coupons SET used_count = used_count + 1 WHERE id = v_payment.coupon_id;
  END IF;

  -- Insert notification for the user
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

  IF v_community.razorpay_account_status = 'activated' AND v_community.razorpay_account_id IS NOT NULL THEN
    INSERT INTO public.payment_transfers (payment_id, community_id, amount, commission_amount, status)
    VALUES (p_payment_id, v_community.id, v_organizer_share, v_platform_fee, 'pending')
    RETURNING id INTO v_transfer_id;

    INSERT INTO public.payment_audit_log (action, payment_id, transfer_id, details)
    VALUES ('payment_confirmed', p_payment_id, v_transfer_id,
      jsonb_build_object('event_id', v_event.id, 'amount', v_payment.amount,
        'organizer_share', v_organizer_share, 'platform_fee', v_platform_fee,
        'commission_on', v_community.commission_on, 'discount', v_discount));
  ELSE
    UPDATE public.communities
    SET wallet_balance = wallet_balance + v_organizer_share
    WHERE id = v_community.id;

    INSERT INTO public.payment_audit_log (action, payment_id, details)
    VALUES ('payment_confirmed', p_payment_id,
      jsonb_build_object('event_id', v_event.id, 'amount', v_payment.amount,
        'organizer_share', v_organizer_share, 'platform_fee', v_platform_fee,
        'commission_on', v_community.commission_on, 'discount', v_discount));
  END IF;

  RETURN jsonb_build_object(
    'action', 'confirmed',
    'payment_id', p_payment_id,
    'transfer_id', v_transfer_id,
    'organizer_share', v_organizer_share,
    'platform_fee', v_platform_fee,
    'commission_on', v_community.commission_on,
    'discount', v_discount
  );
END;
$$;
