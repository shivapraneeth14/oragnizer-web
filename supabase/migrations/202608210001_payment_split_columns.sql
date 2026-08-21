-- ---------------------------------------------------------------------------
-- Persist the payment split (platform fee vs organizer share) on payments.
--
-- Why: the organizer dashboard needs to show "you get ₹Y · fee ₹Z" per
-- registration. The split was previously only computed inside
-- confirm_payment and written to payment_audit_log; now it is stored on the
-- payment row itself.
--
-- 1. Add nullable columns (additive; no existing reads/writes break).
-- 2. Backfill historical success payments from the exact values recorded in
--    payment_audit_log ('payment_confirmed'), with a formula-based fallback
--    for rows missing audit entries (replicates confirm_payment math:
--    coupon discount -> post_discount base -> floor(base * pct / 100)).
-- 3. Re-create confirm_payment (canonical body from 202608100004) with a
--    single changed line: the status='success' UPDATE now also persists
--    v_platform_fee / v_organizer_share. All other behavior byte-identical.
-- ---------------------------------------------------------------------------

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS platform_fee INTEGER,
  ADD COLUMN IF NOT EXISTS organizer_share INTEGER;

COMMENT ON COLUMN public.payments.platform_fee IS 'Platform commission in paise at capture time';
COMMENT ON COLUMN public.payments.organizer_share IS 'Organizer net in paise credited to wallet at capture time';

-- 2a. Preferred backfill: exact recorded values from the audit log.
UPDATE public.payments p
SET platform_fee = (a.details->>'platform_fee')::INTEGER,
    organizer_share = (a.details->>'organizer_share')::INTEGER
FROM (
  SELECT DISTINCT ON (payment_id) payment_id, details
  FROM public.payment_audit_log
  WHERE action = 'payment_confirmed'
  ORDER BY payment_id, created_at DESC
) a
WHERE p.id = a.payment_id
  AND p.status = 'success'
  AND p.platform_fee IS NULL;

-- 2b. Fallback recompute for success payments without audit entries.
WITH base AS (
  SELECT p.id,
         CASE WHEN c.commission_on = 'post_discount'
              THEN GREATEST(
                p.amount - COALESCE(
                  CASE WHEN cp.discount_type = 'percentage'
                       THEN (p.amount * cp.discount_value / 100)::INTEGER
                       ELSE cp.discount_value::INTEGER
                  END, 0), 0)
              ELSE p.amount
         END AS base_amount,
         c.commission_percent
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  JOIN public.events e ON e.id = r.event_id
  JOIN public.communities c ON c.id = e.community_id
  LEFT JOIN public.coupons cp ON cp.id = p.coupon_id
  WHERE p.status = 'success'
    AND p.platform_fee IS NULL
)
UPDATE public.payments p
SET platform_fee = (b.base_amount * b.commission_percent / 100)::INTEGER,
    organizer_share = b.base_amount - (b.base_amount * b.commission_percent / 100)::INTEGER
FROM base b
WHERE p.id = b.id;

-- ---------------------------------------------------------------------------
-- 3. confirm_payment: canonical body (202608100004) + persist the split.
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

  UPDATE public.payments
  SET status = 'success',
      platform_fee = v_platform_fee,
      organizer_share = v_organizer_share
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
