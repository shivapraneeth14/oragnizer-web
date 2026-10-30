-- ============================================================================
-- CLUVO - Admin Financial Ledger, Event Passbook, and Manual Payout Ledger
-- 1. Grant admin full SELECT on payment_refund_history.
-- 2. Add event attribution and manual transfer fields to payout_items.
-- 3. Deploy get_admin_financial_statement RPC for event-wise bank passbook.
-- 4. Deploy admin_record_manual_payout RPC for offline bank transfers.
-- 5. Deploy organizer_confirm_manual_payout RPC for organizer digital acceptance.
-- ============================================================================

-- 1. Admin read policy on payment_refund_history
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'payment_refund_history'
      AND policyname = 'admin_read_all_payment_refund_history'
  ) THEN
    CREATE POLICY "admin_read_all_payment_refund_history"
      ON public.payment_refund_history
      FOR SELECT
      USING (public.is_admin_user());
  END IF;
END;
$$;

-- 2. Add event attribution and manual transfer fields to payout_items
ALTER TABLE public.payout_items
  ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES public.events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'bank_transfer',
  ADD COLUMN IF NOT EXISTS recorded_by_admin UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_by_user UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispute_reason TEXT,
  ADD COLUMN IF NOT EXISTS admin_notes TEXT;

-- Update status check constraint on payout_items to allow 'pending_confirmation' and 'disputed'
ALTER TABLE public.payout_items
  DROP CONSTRAINT IF EXISTS payout_items_status_check;

ALTER TABLE public.payout_items
  ADD CONSTRAINT payout_items_status_check
  CHECK (status IN ('pending', 'processing', 'success', 'failed', 'pending_confirmation', 'disputed', 'cancelled'));

-- 3. Deploy get_admin_financial_statement RPC
CREATE OR REPLACE FUNCTION public.get_admin_financial_statement(
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
BEGIN
  -- Strict privilege check: must be a platform admin
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can view the full financial ledger.';
  END IF;

  WITH raw_transactions AS (
    -- Flow 1: Confirmed Ticket Sales (payments)
    SELECT
      p.created_at,
      p.id AS transaction_id,
      'ticket_sale'::TEXT AS transaction_type,
      p.status AS status,
      'Ticket Purchase'::TEXT AS description,
      p.razorpay_payment_id AS reference_id,
      p.razorpay_order_id AS secondary_ref,
      TRIM(COALESCE(prof.first_name, '') || ' ' || COALESCE(prof.last_name, '')) AS attendee_name,
      prof.email AS attendee_email,
      prof.phone AS attendee_phone,
      r.id AS registration_id,
      r.event_id AS event_id,
      e.title AS event_title,
      CASE
        WHEN r.checked_in THEN 'Attended'
        WHEN r.status = 'cancelled' THEN 'Cancelled'
        ELSE 'Confirmed'
      END AS check_in_status,
      p.amount AS gross_amount,
      COALESCE(p.platform_fee, 0) AS platform_fee,
      COALESCE(p.organizer_share, GREATEST(p.amount - COALESCE(p.platform_fee, 0), 0)) AS organizer_share,
      COALESCE(p.organizer_share, GREATEST(p.amount - COALESCE(p.platform_fee, 0), 0)) AS money_in,
      0::INTEGER AS money_out,
      NULL::TEXT AS refund_reason,
      NULL::TEXT AS admin_notes,
      'razorpay'::TEXT AS payment_method,
      NULL::JSONB AS bank_details,
      NULL::TIMESTAMPTZ AS confirmed_at
    FROM public.payments p
    JOIN public.registrations r ON r.id = p.registration_id
    JOIN public.events e ON e.id = r.event_id
    LEFT JOIN public.profiles prof ON prof.id = r.user_id
    WHERE e.community_id = p_community_id
      AND (p_event_id IS NULL OR r.event_id = p_event_id)
      AND p.status IN ('success', 'refunded')

    UNION ALL

    -- Flow 2: Customer Refunds (payment_refund_history)
    SELECT
      prh.created_at,
      prh.id AS transaction_id,
      'refund'::TEXT AS transaction_type,
      COALESCE(prh.refund_status, 'processed') AS status,
      ('Refund: ' || COALESCE(prh.refund_reason, 'Ticket cancelled'))::TEXT AS description,
      prh.razorpay_refund_id AS reference_id,
      prh.payment_id::TEXT AS secondary_ref,
      TRIM(COALESCE(prof.first_name, '') || ' ' || COALESCE(prof.last_name, '')) AS attendee_name,
      prof.email AS attendee_email,
      prof.phone AS attendee_phone,
      r.id AS registration_id,
      prh.event_id AS event_id,
      e.title AS event_title,
      'Refunded'::TEXT AS check_in_status,
      COALESCE(prh.payment_amount, prh.amount) AS gross_amount,
      COALESCE(prh.platform_fee, 0) AS platform_fee,
      prh.amount AS organizer_share,
      0::INTEGER AS money_in,
      prh.amount AS money_out,
      prh.refund_reason AS refund_reason,
      NULL::TEXT AS admin_notes,
      'razorpay'::TEXT AS payment_method,
      NULL::JSONB AS bank_details,
      NULL::TIMESTAMPTZ AS confirmed_at
    FROM public.payment_refund_history prh
    JOIN public.registrations r ON r.id = prh.registration_id
    JOIN public.events e ON e.id = prh.event_id
    LEFT JOIN public.profiles prof ON prof.id = r.user_id
    WHERE e.community_id = p_community_id
      AND (p_event_id IS NULL OR prh.event_id = p_event_id)

    UNION ALL

    -- Flow 3: Manual Payouts & Transfers (payout_items)
    SELECT
      pi.created_at,
      pi.id AS transaction_id,
      CASE
        WHEN pi.status = 'success' THEN 'payout_confirmed'
        WHEN pi.status = 'disputed' THEN 'payout_disputed'
        ELSE 'payout_pending'
      END::TEXT AS transaction_type,
      pi.status AS status,
      ('Payout → ' || COALESCE(cb.label, cb.account_holder, 'Bank Transfer'))::TEXT AS description,
      pi.utr AS reference_id,
      pi.id::TEXT AS secondary_ref,
      cb.account_holder AS attendee_name,
      NULL::TEXT AS attendee_email,
      NULL::TEXT AS attendee_phone,
      NULL::UUID AS registration_id,
      pi.event_id AS event_id,
      e.title AS event_title,
      pi.status AS check_in_status,
      pi.amount AS gross_amount,
      0::INTEGER AS platform_fee,
      pi.amount AS organizer_share,
      0::INTEGER AS money_in,
      pi.amount AS money_out,
      pi.dispute_reason AS refund_reason,
      pi.admin_notes AS admin_notes,
      COALESCE(pi.payment_method, 'bank_transfer') AS payment_method,
      CASE WHEN cb.id IS NOT NULL THEN
        jsonb_build_object(
          'account_holder', cb.account_holder,
          'bank_account_number', cb.bank_account_number,
          'bank_ifsc', cb.bank_ifsc,
          'label', cb.label
        )
      ELSE NULL END AS bank_details,
      pi.confirmed_at AS confirmed_at
    FROM public.payout_items pi
    LEFT JOIN public.community_beneficiaries cb ON cb.id = pi.beneficiary_id
    LEFT JOIN public.events e ON e.id = pi.event_id
    WHERE pi.community_id = p_community_id
      AND (p_event_id IS NULL OR pi.event_id = p_event_id)
  ),
  with_running_balance AS (
    SELECT
      rt.*,
      SUM(rt.money_in - CASE WHEN rt.status IN ('success', 'processed') THEN rt.money_out ELSE 0 END)
        OVER (ORDER BY rt.created_at ASC) AS running_balance
    FROM raw_transactions rt
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'transaction_id', w.transaction_id,
      'created_at', w.created_at,
      'transaction_type', w.transaction_type,
      'status', w.status,
      'description', w.description,
      'reference_id', w.reference_id,
      'secondary_ref', w.secondary_ref,
      'attendee_name', w.attendee_name,
      'attendee_email', w.attendee_email,
      'attendee_phone', w.attendee_phone,
      'registration_id', w.registration_id,
      'event_id', w.event_id,
      'event_title', w.event_title,
      'check_in_status', w.check_in_status,
      'gross_amount', w.gross_amount,
      'platform_fee', w.platform_fee,
      'organizer_share', w.organizer_share,
      'money_in', w.money_in,
      'money_out', w.money_out,
      'running_balance', w.running_balance,
      'refund_reason', w.refund_reason,
      'admin_notes', w.admin_notes,
      'payment_method', w.payment_method,
      'bank_details', w.bank_details,
      'confirmed_at', w.confirmed_at
    )
    ORDER BY w.created_at DESC
  ) INTO v_result
  FROM with_running_balance w;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_admin_financial_statement(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_financial_statement(UUID, UUID) TO authenticated, service_role;

-- 4. Deploy admin_record_manual_payout RPC
CREATE OR REPLACE FUNCTION public.admin_record_manual_payout(
  p_community_id UUID,
  p_amount INTEGER,
  p_utr TEXT,
  p_payment_method TEXT DEFAULT 'IMPS',
  p_event_id UUID DEFAULT NULL,
  p_admin_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_community RECORD;
  v_beneficiary RECORD;
  v_payout_id UUID;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can record manual payouts.';
  END IF;

  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payout amount must be greater than zero.');
  END IF;

  IF TRIM(COALESCE(p_utr, '')) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UTR / Bank transaction reference is required.');
  END IF;

  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = p_community_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Community not found.');
  END IF;

  -- Find active beneficiary
  SELECT cb.* INTO v_beneficiary
  FROM public.community_beneficiaries cb
  WHERE cb.community_id = p_community_id
    AND cb.is_active = true
  LIMIT 1;

  INSERT INTO public.payout_items (
    community_id,
    event_id,
    amount,
    currency,
    status,
    utr,
    beneficiary_id,
    payment_method,
    admin_notes,
    recorded_by_admin
  )
  VALUES (
    p_community_id,
    p_event_id,
    p_amount,
    'INR',
    'pending_confirmation',
    TRIM(p_utr),
    v_beneficiary.id,
    p_payment_method,
    p_admin_notes,
    auth.uid()
  )
  RETURNING id INTO v_payout_id;

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('manual_payout_recorded', jsonb_build_object(
    'payout_id', v_payout_id,
    'community_id', p_community_id,
    'event_id', p_event_id,
    'amount', p_amount,
    'utr', p_utr,
    'admin_id', auth.uid()
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'payout_id', v_payout_id,
    'amount', p_amount,
    'status', 'pending_confirmation'
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_record_manual_payout(UUID, INTEGER, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_record_manual_payout(UUID, INTEGER, TEXT, TEXT, UUID, TEXT) TO authenticated, service_role;

-- 5. Deploy organizer_confirm_manual_payout RPC
CREATE OR REPLACE FUNCTION public.organizer_confirm_manual_payout(
  p_payout_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payout RECORD;
  v_community RECORD;
  v_new_balance INTEGER;
BEGIN
  SELECT pi.* INTO v_payout
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payout record not found.');
  END IF;

  -- Authorization check: Caller must be the community owner
  IF NOT (public.is_community_owner(v_payout.community_id) OR public.is_admin_user()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not authorized to confirm this payout.');
  END IF;

  IF v_payout.status != 'pending_confirmation' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payout is not in pending confirmation state.');
  END IF;

  -- Lock community row for atomic balance deduction
  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = v_payout.community_id
  FOR UPDATE OF c;

  IF v_community.wallet_balance < v_payout.amount THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Insufficient community wallet balance.');
  END IF;

  -- Deduct community wallet
  UPDATE public.communities
  SET wallet_balance = wallet_balance - v_payout.amount
  WHERE id = v_payout.community_id
  RETURNING wallet_balance INTO v_new_balance;

  -- Mark payout as success
  UPDATE public.payout_items
  SET status = 'success',
      confirmed_by_user = auth.uid(),
      confirmed_at = now()
  WHERE id = p_payout_id;

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('wallet_debited', jsonb_build_object(
    'community_id', v_payout.community_id,
    'amount', v_payout.amount,
    'new_balance', v_new_balance,
    'reason', 'Manual payout confirmed: ' || COALESCE(v_payout.utr, ''),
    'payout_id', p_payout_id,
    'event_id', v_payout.event_id
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'payout_id', p_payout_id,
    'amount', v_payout.amount,
    'new_balance', v_new_balance,
    'status', 'success'
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.organizer_confirm_manual_payout(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.organizer_confirm_manual_payout(UUID) TO authenticated, service_role;
