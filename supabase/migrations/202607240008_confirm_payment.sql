CREATE OR REPLACE FUNCTION confirm_payment(p_payment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment RECORD;
  v_registration RECORD;
  v_event RECORD;
  v_community RECORD;
  v_platform_fee INTEGER;
  v_organizer_share INTEGER;
  v_updated INTEGER;
  v_transfer_id UUID;
BEGIN
  -- Lock and fetch payment
  SELECT p.*, r.event_id, r.user_id, r.status AS reg_status
  INTO v_payment
  FROM payments p
  JOIN registrations r ON r.id = p.registration_id
  WHERE p.id = p_payment_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  -- Idempotency: already processed
  IF v_payment.status = 'success' THEN
    RETURN jsonb_build_object('skipped', true, 'payment_id', p_payment_id);
  END IF;

  -- Fetch event + community
  SELECT e.* INTO v_event FROM events e WHERE e.id = v_payment.event_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Event not found');
  END IF;

  SELECT c.* INTO v_community FROM communities c WHERE c.id = v_event.community_id;

  -- Atomic capacity check + increment
  UPDATE events e SET booked_count = booked_count + 1
  WHERE e.id = v_event.id
    AND (e.capacity IS NULL OR e.booked_count < e.capacity);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    -- Capacity full — mark payment for refund
    UPDATE payments SET status = 'failed' WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id);
  END IF;

  -- Calculate split (platform_fee = round up, organizer_share = subtraction for exact sum)
  v_platform_fee := (v_payment.amount * v_community.commission_percent / 100)::INTEGER;
  v_organizer_share := v_payment.amount - v_platform_fee;

  -- Mark payment success
  UPDATE payments SET status = 'success' WHERE id = p_payment_id;

  -- Confirm registration
  UPDATE registrations SET status = 'confirmed' WHERE id = v_payment.registration_id;

  -- Create transfer record
  INSERT INTO payment_transfers (payment_id, community_id, amount, commission_amount, status)
  VALUES (p_payment_id, v_community.id, v_organizer_share, v_platform_fee,
    CASE WHEN v_community.razorpay_account_status = 'activated' AND v_community.razorpay_account_id IS NOT NULL
      THEN 'pending' ELSE 'pending' END)
  RETURNING id INTO v_transfer_id;

  -- Audit log
  INSERT INTO payment_audit_log (action, payment_id, transfer_id, details)
  VALUES ('payment_confirmed', p_payment_id, v_transfer_id,
    jsonb_build_object('event_id', v_event.id, 'amount', v_payment.amount,
      'organizer_share', v_organizer_share, 'platform_fee', v_platform_fee));

  RETURN jsonb_build_object(
    'action', 'confirmed',
    'payment_id', p_payment_id,
    'transfer_id', v_transfer_id,
    'organizer_share', v_organizer_share,
    'platform_fee', v_platform_fee
  );
END;
$$;
