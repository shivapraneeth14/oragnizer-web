-- ============================================================================
-- CLUVO — Confirm payment now writes the immutable sale record
--
-- Changes (all other behaviour is byte-for-byte identical):
--   1. A successful capture INSERTs one payment_sales row.
--   2. The organizer wallet is credited ONLY when that insert actually
--      happened. The unique capture id becomes the idempotency key, closing a
--      duplicate-webhook double-credit gap that existed before.
--   3. A fresh QR token is minted on every confirmed booking (the old
--      COALESCE resurrected a previously revoked token after a rebook).
--   4. A confirmation for an already-successful payment heals a missing sale
--      row instead of silently doing nothing.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_payment(
  p_payment_id uuid,
  p_expected_amount integer DEFAULT NULL,
  p_expected_currency text DEFAULT 'INR',
  p_razorpay_payment_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_payment RECORD;
  v_reg RECORD;
  v_event RECORD;
  v_community RECORD;
  v_updated INTEGER;
  v_platform_fee INTEGER;
  v_organizer_share INTEGER;
  v_reg_id UUID;
  v_event_id UUID;
  v_capture_id TEXT;
  v_sale_id UUID;
BEGIN
  SET LOCAL lock_timeout = '3s';

  SELECT p.registration_id, r.event_id
  INTO v_reg_id, v_event_id
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  WHERE p.id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment or registration not found');
  END IF;

  SELECT * INTO v_event
  FROM public.events
  WHERE id = v_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Event not found');
  END IF;

  SELECT * INTO v_reg
  FROM public.registrations
  WHERE id = v_reg_id
  FOR UPDATE;

  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF p_razorpay_payment_id IS NOT NULL AND v_payment.razorpay_payment_id IS NULL THEN
    UPDATE public.payments
    SET razorpay_payment_id = p_razorpay_payment_id
    WHERE id = p_payment_id;
    v_payment.razorpay_payment_id := p_razorpay_payment_id;
  END IF;

  -- A row that already points at a DIFFERENT provider capture must never be
  -- confirmed by this webhook. This is the stale/late-delivery case after a
  -- cancel -> rebook: the new checkout owns the row, and the old capture's
  -- webhook must not resurrect it (and must not write a sale for the new
  -- booking with the old capture id). Skipping is idempotent and lets the
  -- provider stop retrying.
  IF p_razorpay_payment_id IS NOT NULL
     AND v_payment.razorpay_payment_id IS NOT NULL
     AND v_payment.razorpay_payment_id IS DISTINCT FROM p_razorpay_payment_id THEN
    RETURN jsonb_build_object(
      'action', 'skipped',
      'reason', 'capture_id_mismatch',
      'payment_id', p_payment_id
    );
  END IF;

  IF p_expected_amount IS NOT NULL AND v_payment.amount != p_expected_amount THEN
    RETURN jsonb_build_object('error', 'Amount mismatch', 'code', 400);
  END IF;

  IF p_expected_currency IS NOT NULL AND v_payment.currency != p_expected_currency THEN
    RETURN jsonb_build_object('error', 'Currency mismatch', 'code', 400);
  END IF;

  v_capture_id := COALESCE(p_razorpay_payment_id, v_payment.razorpay_payment_id);

  -- Already confirmed: heal a missing sale row (legacy rows written before
  -- this ledger existed) and return without moving money again.
  IF v_payment.status IN ('success', 'refunded') THEN
    IF v_capture_id IS NOT NULL THEN
      INSERT INTO public.payment_sales (
        payment_id, registration_id, event_id, community_id, user_id,
        razorpay_order_id, razorpay_payment_id, attempt_count, currency,
        gross_amount, ticket_amount, platform_fee, platform_fee_gst,
        captured_at, source
      )
      SELECT
        p.id, r.id, r.event_id, e.community_id, r.user_id,
        COALESCE(p.razorpay_order_id, 'legacy_' || p.id::text),
        v_capture_id,
        GREATEST(COALESCE(p.attempt_count, 0), 1),
        COALESCE(p.currency, 'INR'),
        p.amount,
        GREATEST(p.amount - COALESCE(p.platform_fee, 0) - COALESCE(p.platform_fee_gst, 0), 0),
        GREATEST(COALESCE(p.platform_fee, 0), 0),
        GREATEST(COALESCE(p.platform_fee_gst, 0), 0),
        p.created_at,
        'backfill'
      FROM public.payments p
      JOIN public.registrations r ON r.id = p.registration_id
      JOIN public.events e ON e.id = r.event_id
      WHERE p.id = p_payment_id
      ON CONFLICT (razorpay_payment_id) DO NOTHING;
    END IF;

    RETURN jsonb_build_object('skipped', true, 'payment_id', p_payment_id);
  END IF;

  IF v_reg.status = 'cancelled' THEN
    UPDATE public.payments
    SET status = 'failed',
        failure_reason = 'registration_cancelled',
        refund_reason = COALESCE(refund_reason, 'registration_cancellation')
    WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id, 'reason', 'registration_cancellation');
  END IF;

  IF v_event.status IN ('cancelled', 'cancelling') THEN
    UPDATE public.payments
    SET status = 'failed',
        failure_reason = 'event_cancelled',
        refund_reason = COALESCE(refund_reason, 'event_cancellation')
    WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id, 'reason', 'event_cancellation');
  END IF;

  IF v_capture_id IS NULL THEN
    -- Money cannot be recorded as a sale without its provider capture id.
    -- This is a hard error: never credit a wallet for an unidentifiable sale.
    RETURN jsonb_build_object('error', 'Missing Razorpay payment id', 'code', 400);
  END IF;

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
        hold_expires_at = NULL,
        qr_code = NULL
    WHERE id = v_reg_id;

    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id, 'reason', 'capacity_full');
  END IF;

  v_platform_fee := GREATEST(COALESCE(v_payment.platform_fee, 0), 0);
  v_organizer_share := GREATEST(v_payment.amount - v_platform_fee, 0);

  UPDATE public.payments
  SET status = 'success',
      platform_fee = v_platform_fee,
      platform_fee_gst = NULL,
      organizer_share = v_organizer_share,
      ticket_price = v_organizer_share,
      failure_reason = NULL,
      updated_at = clock_timestamp()
  WHERE id = p_payment_id;

  -- Rotate the ticket credential on every confirmed booking. Reusing the old
  -- token would silently re-validate a screenshot from a cancelled booking.
  UPDATE public.registrations
  SET status = 'confirmed',
      hold_expires_at = NULL,
      qr_code = 'cluvo_' || encode(
        sha256((gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text)::bytea),
        'hex'
      ),
      updated_at = clock_timestamp()
  WHERE id = v_reg_id;

  SELECT * INTO v_community FROM public.communities WHERE id = v_event.community_id;

  INSERT INTO public.payment_sales (
    payment_id, registration_id, event_id, community_id, user_id,
    razorpay_order_id, razorpay_payment_id, attempt_count, currency,
    gross_amount, ticket_amount, platform_fee, platform_fee_gst,
    captured_at, source
  )
  VALUES (
    p_payment_id, v_reg_id, v_event_id, v_event.community_id, v_reg.user_id,
    COALESCE(v_payment.razorpay_order_id, 'unknown_' || p_payment_id::text),
    v_capture_id,
    GREATEST(COALESCE(v_payment.attempt_count, 0), 1),
    COALESCE(v_payment.currency, 'INR'),
    v_payment.amount,
    v_organizer_share,
    v_platform_fee,
    0,
    clock_timestamp(),
    'live'
  )
  ON CONFLICT (razorpay_payment_id) DO NOTHING
  RETURNING id INTO v_sale_id;

  -- The sale insert is the idempotency key for the wallet credit. A duplicate
  -- webhook that lost the status race cannot credit twice.
  IF v_sale_id IS NOT NULL THEN
    PERFORM public.credit_wallet(v_community.id, v_organizer_share, v_event.id, p_payment_id);
  END IF;

  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('payment_confirmed', p_payment_id,
    jsonb_build_object(
      'event_id', v_event.id,
      'amount', v_payment.amount,
      'organizer_share', v_organizer_share,
      'platform_fee', v_platform_fee,
      'commission_on', v_community.commission_on,
      'sale_id', v_sale_id
    ));

  IF v_reg.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, title, body, type)
    VALUES (
      v_reg.user_id,
      'Booking Confirmed!',
      'Your ticket for "' || v_event.title || '" is confirmed.',
      'booking'
    );
  END IF;

  RETURN jsonb_build_object(
    'action', 'confirmed',
    'payment_id', p_payment_id,
    'sale_id', v_sale_id
  );
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payment(uuid, integer, text, text) TO service_role;
