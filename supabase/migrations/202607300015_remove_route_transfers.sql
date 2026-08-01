-- ============================================================================
-- Tier 4: Remove Razorpay Route/transfer dead code
-- 1. confirm_payment — always credit_wallet (Route branch removed)
-- 2. get_wallet_statement — credits sourced from payment_audit_log, not
--    payment_transfers (table is being dropped)
-- 3. Drop payment_transfers table + payment_audit_log.transfer_id FK/column
-- 4. Drop communities.razorpay_account_id / razorpay_account_status
-- 5. Drop profiles Route-specific bank/KYC columns
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. confirm_payment — always credit_wallet, no Route branch
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

  SELECT c.* INTO v_community FROM public.communities c WHERE c.id = v_event.community_id;

  UPDATE public.events e SET booked_count = booked_count + 1
  WHERE e.id = v_event.id
    AND (e.capacity IS NULL OR e.booked_count < e.capacity);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    UPDATE public.payments SET status = 'failed' WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id);
  END IF;

  -- Base amount for commission (post_discount support)
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

  -- Always credit the wallet (Route transfers removed)
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

-- ---------------------------------------------------------------------------
-- 2. get_wallet_statement — no payment_transfers dependency
-- Credits now come from payment_audit_log 'wallet_credited' entries
-- (written by credit_wallet, which confirm_payment always calls now).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS get_wallet_statement(UUID);

CREATE OR REPLACE FUNCTION get_wallet_statement(p_community_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSONB;
BEGIN
  WITH transactions AS (
    SELECT
      al.created_at,
      'credit' AS ttype,
      (al.details->>'amount')::INTEGER AS net_amount,
      (al.details->>'amount')::INTEGER AS credit_amount,
      NULL::INTEGER AS debit_amount,
      'Payment received' AS description,
      NULL::UUID AS payment_id,
      NULL::UUID AS payout_id
    FROM public.payment_audit_log al
    WHERE al.action = 'wallet_credited'
      AND al.details->>'community_id' = p_community_id::TEXT

    UNION ALL

    SELECT
      pi.created_at,
      'debit' AS ttype,
      -pi.amount AS net_amount,
      NULL::INTEGER AS credit_amount,
      pi.amount AS debit_amount,
      'Withdrawal → ' || COALESCE(cb.label, cb.account_holder, 'Unknown') AS description,
      NULL::UUID AS payment_id,
      pi.id AS payout_id
    FROM public.payout_items pi
    LEFT JOIN public.community_beneficiaries cb ON cb.id = pi.beneficiary_id
    WHERE pi.community_id = p_community_id
      AND pi.status IN ('processing', 'success')

    UNION ALL

    SELECT
      al.created_at,
      'refund' AS ttype,
      (al.details->>'amount')::INTEGER AS net_amount,
      (al.details->>'amount')::INTEGER AS credit_amount,
      NULL::INTEGER AS debit_amount,
      'Refund: ' || COALESCE(al.details->>'reason', 'Stuck payout refund') AS description,
      NULL::UUID AS payment_id,
      (al.details->>'payout_id')::UUID AS payout_id
    FROM public.payment_audit_log al
    WHERE al.action IN ('payout_stuck_refunded', 'wallet_refunded')
      AND al.details->>'community_id' = p_community_id::TEXT
  ),
  with_balance AS (
    SELECT *,
      SUM(t.net_amount) OVER (
        ORDER BY t.created_at, CASE WHEN t.ttype = 'credit' THEN 0 ELSE 1 END
      ) AS running_balance
    FROM transactions t
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'created_at', w.created_at,
      'type', w.ttype,
      'credit_amount', w.credit_amount,
      'debit_amount', w.debit_amount,
      'amount', ABS(w.net_amount),
      'description', w.description,
      'payment_id', w.payment_id,
      'payout_id', w.payout_id,
      'running_balance', w.running_balance
    )
    ORDER BY w.created_at ASC
  ) INTO v_result
  FROM with_balance w;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Drop payment_audit_log.transfer_id FK + column, then payment_transfers
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_audit_log
  DROP CONSTRAINT IF EXISTS payment_audit_log_transfer_id_fkey;

ALTER TABLE public.payment_audit_log
  DROP COLUMN IF EXISTS transfer_id;

DROP TABLE IF EXISTS public.payment_transfers;

-- ---------------------------------------------------------------------------
-- 4. Drop communities Route columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.communities
  DROP CONSTRAINT IF EXISTS communities_razorpay_account_status_check;

ALTER TABLE public.communities
  DROP COLUMN IF EXISTS razorpay_account_id,
  DROP COLUMN IF EXISTS razorpay_account_status;

-- ---------------------------------------------------------------------------
-- 5. Drop profiles Route-specific bank/KYC columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_kyc_status_check;

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS razorpay_contact_id,
  DROP COLUMN IF EXISTS razorpay_fund_account_id,
  DROP COLUMN IF EXISTS bank_account_holder,
  DROP COLUMN IF EXISTS bank_ifsc,
  DROP COLUMN IF EXISTS bank_account_number,
  DROP COLUMN IF EXISTS pan,
  DROP COLUMN IF EXISTS kyc_status;
