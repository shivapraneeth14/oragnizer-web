-- ============================================================================
-- CLUVO — Payment data-integrity fixes (Stage 6 remediation)
--
-- Bug 2: payments.ticket_price was never written (always 0). Set it to the
--        organizer share (= ticket price in the fee-on-top model).
-- Bug 3: wallet_credited / wallet_debited audit rows lacked payment_id. Thread
--        payment_id through credit_wallet / debit_wallet.
-- Bug 4: confirm_payment no longer wrote a payment_confirmed audit row.
-- Bug 5: platform_fee_gst was NULL while pending but 0 after success. Make it
--        consistently NULL (no GST model exists).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- credit_wallet: accept and record the originating payment_id.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_wallet(
  p_community_id uuid,
  p_amount integer,
  p_event_id uuid DEFAULT NULL,
  p_payment_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  UPDATE public.communities
  SET wallet_balance = wallet_balance + p_amount
  WHERE id = p_community_id;

  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('wallet_credited', p_payment_id,
    jsonb_build_object(
      'community_id', p_community_id,
      'amount', p_amount,
      'event_id', p_event_id
    ));

  RETURN jsonb_build_object('credited', true, 'amount', p_amount);
END;
$function$;

-- ---------------------------------------------------------------------------
-- debit_wallet: accept and record the originating payment_id.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.debit_wallet(
  p_community_id uuid,
  p_amount integer,
  p_reason text DEFAULT 'debit',
  p_event_id uuid DEFAULT NULL,
  p_payment_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_community RECORD;
  v_new_balance INTEGER;
BEGIN
  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = p_community_id
  FOR UPDATE OF c;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Community not found');
  END IF;

  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('error', 'Amount must be positive');
  END IF;

  IF v_community.wallet_balance < p_amount THEN
    RETURN jsonb_build_object('error', 'Insufficient wallet balance');
  END IF;

  UPDATE public.communities
  SET wallet_balance = wallet_balance - p_amount
  WHERE id = p_community_id
  RETURNING wallet_balance INTO v_new_balance;

  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('wallet_debited', p_payment_id,
    jsonb_build_object('community_id', p_community_id, 'amount', p_amount,
      'new_balance', v_new_balance, 'reason', p_reason, 'event_id', p_event_id));

  RETURN jsonb_build_object('debited', true, 'amount', p_amount, 'new_balance', v_new_balance);
END;
$function$;

-- ---------------------------------------------------------------------------
-- confirm_payment: persist ticket_price, write payment_confirmed audit, keep
-- platform_fee_gst consistent (NULL), and pass payment_id to credit_wallet.
-- ---------------------------------------------------------------------------
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

  IF p_expected_amount IS NOT NULL AND v_payment.amount != p_expected_amount THEN
    RETURN jsonb_build_object('error', 'Amount mismatch', 'code', 400);
  END IF;

  IF p_expected_currency IS NOT NULL AND v_payment.currency != p_expected_currency THEN
    RETURN jsonb_build_object('error', 'Currency mismatch', 'code', 400);
  END IF;

  IF v_payment.status IN ('success', 'refunded') THEN
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

  UPDATE public.registrations
  SET status = 'confirmed',
      hold_expires_at = NULL,
      qr_code = COALESCE(
        v_reg.qr_code,
        'cluvo_' || encode(sha256((gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text)::bytea), 'hex')
      ),
      updated_at = clock_timestamp()
  WHERE id = v_reg_id;

  SELECT * INTO v_community FROM public.communities WHERE id = v_event.community_id;
  PERFORM public.credit_wallet(v_community.id, v_organizer_share, v_event.id, p_payment_id);

  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('payment_confirmed', p_payment_id,
    jsonb_build_object(
      'event_id', v_event.id,
      'amount', v_payment.amount,
      'organizer_share', v_organizer_share,
      'platform_fee', v_platform_fee,
      'commission_on', v_community.commission_on
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

  RETURN jsonb_build_object('action', 'confirmed', 'payment_id', p_payment_id);
END;
$function$;

-- Ensure confirm_payment stays service_role-only (defense in depth).
REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payment(uuid, integer, text, text) TO service_role;
