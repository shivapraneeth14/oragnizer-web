-- ============================================================================
-- CLUVO - PASS 2 (2026-08-10): WALLET EVENT ATTRIBUTION + HONEST STATEMENT
-- + TEAM AUDIT READ
--
-- 1. credit_wallet / debit_wallet gain a trailing p_event_id UUID DEFAULT
--    NULL. Every wallet movement caused by a payment or refund now records
--    which event it belongs to (powers the per-event organizer ledger and
--    the refund dashboard).
-- 2. get_wallet_statement(p_community_id, p_event_id UUID DEFAULT NULL):
--    - refund clawbacks (wallet_debited rows) now appear as 'refund' rows
--      instead of vanishing from the statement
--    - optional event filter: only rows for that event (payouts excluded)
--    - surfaces payment_id / event_id when the audit trail has them
-- 3. audit_log_team_read(p_community_id): SECURITY DEFINER RPC letting
--    community owners / MODERATOR / ORGANIZER members read the payment and
--    refund audit trail for their community's events. Platform admins keep
--    the existing admin_read_audit_log RPC (all rows, all communities).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Drop the OLD signatures first. CREATE OR REPLACE cannot change a
--    function's argument count - without these DROPs Postgres would create
--    second overloads and old callers would keep the unattributed code path.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.credit_wallet(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.debit_wallet(UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS public.get_wallet_statement(UUID);

-- ---------------------------------------------------------------------------
-- 1. credit_wallet / debit_wallet: event attribution
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION credit_wallet(
  p_community_id UUID,
  p_amount INTEGER,
  p_event_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.communities
  SET wallet_balance = wallet_balance + p_amount
  WHERE id = p_community_id;

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('wallet_credited',
    jsonb_build_object(
      'community_id', p_community_id,
      'amount', p_amount,
      'event_id', p_event_id
    ));

  RETURN jsonb_build_object('credited', true, 'amount', p_amount);
END;
$$;

CREATE OR REPLACE FUNCTION debit_wallet(
  p_community_id UUID,
  p_amount INTEGER,
  p_reason TEXT DEFAULT 'debit',
  p_event_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('wallet_debited',
    jsonb_build_object('community_id', p_community_id, 'amount', p_amount,
      'new_balance', v_new_balance, 'reason', p_reason, 'event_id', p_event_id));

  RETURN jsonb_build_object('debited', true, 'amount', p_amount, 'new_balance', v_new_balance);
END;
$$;

-- ---------------------------------------------------------------------------
-- 1b. confirm_payment: raise the organizer share WITH event attribution.
--     Signature unchanged; this is a straight re-creation of the canonical
--     body (202608100001) with p_event_id passed to credit_wallet so that
--     per-event statements and the refund dashboard see payment credits.
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

-- ---------------------------------------------------------------------------
-- 2. get_wallet_statement: honest running balance + refund clawbacks + filter
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_wallet_statement(
  p_community_id UUID,
  p_event_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSONB;
  v_balance INTEGER;
BEGIN
  SELECT wallet_balance INTO v_balance
  FROM public.communities
  WHERE id = p_community_id;

  WITH transactions AS (
    -- Customer-held credits (raises) and organizer shares from payments
    SELECT
      al.created_at,
      'credit' AS ttype,
      (al.details->>'amount')::INTEGER AS net_amount,
      (al.details->>'amount')::INTEGER AS credit_amount,
      NULL::INTEGER AS debit_amount,
      'Payment received' AS description,
      NULL::UUID AS payment_id,
      NULL::UUID AS payout_id,
      (al.details->>'event_id')::UUID AS event_id
    FROM public.payment_audit_log al
    WHERE al.action = 'wallet_credited'
      AND al.details->>'community_id' = p_community_id::TEXT
      AND (p_event_id IS NULL OR (al.details->>'event_id')::UUID = p_event_id)

    UNION ALL

    -- Refund clawbacks: organizer share pulled back for refunded payments
    SELECT
      al.created_at,
      'refund' AS ttype,
      -(al.details->>'amount')::INTEGER AS net_amount,
      NULL::INTEGER AS credit_amount,
      (al.details->>'amount')::INTEGER AS debit_amount,
      'Refund: ' || COALESCE(al.details->>'reason', 'Payment refunded') AS description,
      NULL::UUID AS payment_id,
      NULL::UUID AS payout_id,
      (al.details->>'event_id')::UUID AS event_id
    FROM public.payment_audit_log al
    WHERE al.action = 'wallet_debited'
      AND al.details->>'community_id' = p_community_id::TEXT
      AND (p_event_id IS NULL OR (al.details->>'event_id')::UUID = p_event_id)

    UNION ALL

    -- Failed-payout refunds: money RETURNED to the wallet (a credit)
    SELECT
      al.created_at,
      'credit' AS ttype,
      (al.details->>'amount')::INTEGER AS net_amount,
      (al.details->>'amount')::INTEGER AS credit_amount,
      NULL::INTEGER AS debit_amount,
      'Refund: ' || COALESCE(al.details->>'reason', 'Stuck payout refund') AS description,
      NULL::UUID AS payment_id,
      (al.details->>'payout_id')::UUID AS payout_id,
      (al.details->>'event_id')::UUID AS event_id
    FROM public.payment_audit_log al
    WHERE al.action IN ('payout_stuck_refunded', 'wallet_refunded')
      AND al.details->>'community_id' = p_community_id::TEXT
      AND (p_event_id IS NULL OR (al.details->>'event_id')::UUID = p_event_id)

    UNION ALL

    -- Payouts (never event-scoped; excluded when filtering by event)
    SELECT
      pi.created_at,
      'debit' AS ttype,
      -pi.amount AS net_amount,
      NULL::INTEGER AS credit_amount,
      pi.amount AS debit_amount,
      'Withdrawal → ' || COALESCE(cb.label, cb.account_holder, 'Bank account') AS description,
      NULL::UUID AS payment_id,
      pi.id AS payout_id,
      NULL::UUID AS event_id
    FROM public.payout_items pi
    LEFT JOIN public.community_beneficiaries cb ON cb.id = pi.beneficiary_id
    WHERE pi.community_id = p_community_id
      AND p_event_id IS NULL
  ),
  totals AS (
    SELECT COALESCE(SUM(net_amount), 0) AS total_net
    FROM transactions
  ),
  with_balance AS (
    SELECT t.*,
      COALESCE(v_balance, 0) - totals.total_net
        + SUM(t.net_amount) OVER (
            ORDER BY t.created_at, CASE WHEN t.ttype = 'credit' THEN 0 ELSE 1 END
          ) AS running_balance
    FROM transactions t, totals
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
      'event_id', w.event_id,
      'running_balance', w.running_balance
    )
    ORDER BY w.created_at ASC
  ) INTO v_result
  FROM with_balance w;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. audit_log_team_read: community-level audit trail for the refund dashboard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_team_read(p_community_id UUID)
RETURNS SETOF payment_audit_log
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_authorized BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.communities c
    WHERE c.id = p_community_id
      AND c.owner_id = v_user_id
  ) OR EXISTS (
    SELECT 1
    FROM public.community_members cm
    WHERE cm.community_id = p_community_id
      AND cm.user_id = v_user_id
      AND cm.role IN ('MODERATOR', 'ORGANIZER')
  ) OR EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = v_user_id
      AND p.is_admin = true
  ) INTO v_authorized;

  IF NOT v_authorized THEN
    RETURN;
  END IF;

  -- Join through the payment lineage so every payment-level audit row is
  -- included regardless of which details it carries (older rows have no
  -- event_id in details).
  RETURN QUERY
  SELECT al.*
  FROM public.payment_audit_log al
  JOIN public.payments p ON p.id = al.payment_id
  JOIN public.registrations r ON r.id = p.registration_id
  JOIN public.events e ON e.id = r.event_id
  WHERE e.community_id = p_community_id
  ORDER BY al.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION audit_log_team_read(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_wallet_statement(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION credit_wallet(UUID, INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION debit_wallet(UUID, INTEGER, TEXT, UUID) TO authenticated;