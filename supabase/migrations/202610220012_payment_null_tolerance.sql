-- ============================================================================
-- CLUVO — Payment NULL-user tolerance (defect D2)
--
-- Problem: after an account is hard-deleted, registrations.user_id and
-- payments.user_id are SET NULL (202608060003). The confirm_payment RPC
-- still tries to INSERT a notification with v_payment.user_id, which is
-- now NULL — violating the NOT NULL constraint on notifications.user_id.
-- This crashes the entire confirmation transaction, leaving a captured
-- payment unconfirmed and the money stranded.
--
-- Fix: skip the notification insert when user_id IS NULL. The payment
-- confirmation itself (status update, wallet credit, audit log) proceeds
-- normally — only the user-facing notification is skipped.
--
-- Same pattern applies to issue-refund (edge function, not SQL) and
-- verify-payment-webhook (edge function, not SQL) — those are fixed in
-- the TypeScript code, not here.
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
  v_platform_fee INTEGER;
  v_platform_fee_gst INTEGER;
  v_organizer_share INTEGER;
  v_discount INTEGER;
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

  -- Terminal states: a confirmed or already-refunded payment must never be
  -- re-confirmed by a duplicate or retried webhook delivery.
  IF v_payment.status IN ('success', 'refunded') THEN
    RETURN jsonb_build_object('skipped', true, 'payment_id', p_payment_id);
  END IF;

  -- Cancelled-registration guard (from 202610220005): never confirm a payment
  -- whose registration was cancelled. The customer is refunded in full via the
  -- webhook's processRefund path. This guard MUST stay here: 012 redefines the
  -- function after 005, so omitting it would silently reintroduce the bug.
  IF v_payment.reg_status = 'cancelled' THEN
    UPDATE public.payments SET status = 'failed', failure_reason = 'registration_cancelled' WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id,
      'reason', 'registration_cancelled');
  END IF;

  SELECT e.* INTO v_event FROM public.events e WHERE e.id = v_payment.event_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Event not found');
  END IF;

  -- Cancelled-event guard: never confirm a payment on a cancelled event.
  -- The customer gets their money back instead (webhook routes
  -- refund_required to processRefund).
  IF v_event.status = 'cancelled' THEN
    UPDATE public.payments SET status = 'failed', failure_reason = 'event_cancelled' WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id,
      'reason', 'event_cancelled');
  END IF;

  SELECT c.* INTO v_community FROM public.communities c WHERE c.id = v_event.community_id;

  UPDATE public.events e SET booked_count = booked_count + 1
  WHERE e.id = v_event.id
    AND (e.capacity IS NULL OR e.booked_count < e.capacity);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    UPDATE public.payments SET status = 'failed', failure_reason = 'capacity_full' WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id, 'reason', 'capacity_full');
  END IF;

  -- Split was fixed at order creation. Rows from before the fee-on-top
  -- migration have no persisted fee: the customer only ever paid the ticket,
  -- so the organizer receives the whole amount and the platform fee is 0.
  v_platform_fee := GREATEST(COALESCE(v_payment.platform_fee, 0), 0);
  v_platform_fee_gst := GREATEST(COALESCE(v_payment.platform_fee_gst, 0), 0);
  v_organizer_share := GREATEST(v_payment.amount - v_platform_fee, 0);

  -- Informational only: amount already has the coupon baked in
  -- (amount = discounted ticket + fee), so discount = price - organizer share.
  v_discount := CASE
    WHEN v_payment.coupon_id IS NOT NULL
    THEN GREATEST(v_event.price - v_organizer_share, 0)
    ELSE 0
  END;

  UPDATE public.payments
  SET status = 'success',
      platform_fee = v_platform_fee,
      platform_fee_gst = v_platform_fee_gst,
      organizer_share = v_organizer_share,
      failure_reason = NULL
  WHERE id = p_payment_id;
  UPDATE public.registrations
  SET status = 'confirmed',
      qr_code = encode(
        sha256(
          (p_payment_id::text || v_event.id::text || v_payment.registration_id::text)::bytea
        ),
        'hex'
      )
  WHERE id = v_payment.registration_id;

  PERFORM public.credit_wallet(v_community.id, v_organizer_share, v_event.id);

  -- D2 fix: skip the notification when the user has been deleted (user_id
  -- is NULL after the account purge). The money logic above has already
  -- committed; only the user-facing notification is skipped.
  IF v_payment.user_id IS NOT NULL THEN
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
  END IF;

  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('payment_confirmed', p_payment_id,
    jsonb_build_object('event_id', v_event.id, 'amount', v_payment.amount,
      'ticket_price', v_organizer_share, 'organizer_share', v_organizer_share,
      'platform_fee', v_platform_fee, 'platform_fee_gst', v_platform_fee_gst,
      'fee_model', 'flat_on_top', 'discount', v_discount));

  RETURN jsonb_build_object(
    'action', 'confirmed',
    'payment_id', p_payment_id,
    'organizer_share', v_organizer_share,
    'platform_fee', v_platform_fee,
    'platform_fee_gst', v_platform_fee_gst,
    'fee_model', 'flat_on_top',
    'discount', v_discount
  );
END;
$$;
