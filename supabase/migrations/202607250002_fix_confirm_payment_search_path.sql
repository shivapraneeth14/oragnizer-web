-- Fix confirm_payment RPC: qualify all table names with public.
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

  v_platform_fee := (v_payment.amount * v_community.commission_percent / 100)::INTEGER;
  v_organizer_share := v_payment.amount - v_platform_fee;

  UPDATE public.payments SET status = 'success' WHERE id = p_payment_id;
  UPDATE public.registrations SET status = 'confirmed' WHERE id = v_payment.registration_id;

  INSERT INTO public.payment_transfers (payment_id, community_id, amount, commission_amount, status)
  VALUES (p_payment_id, v_community.id, v_organizer_share, v_platform_fee, 'pending')
  RETURNING id INTO v_transfer_id;

  INSERT INTO public.payment_audit_log (action, payment_id, transfer_id, details)
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
