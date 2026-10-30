-- ============================================================================
-- CLUVO — Fix Financial Ledger attendee_phone and deploy get_admin_profiles RPC
--
-- 1. Fix get_admin_financial_statement:
--    - Remove non-existent profiles phone column references, replace with NULL::TEXT.
--    - Robust attendee_name fallback: first/last name -> username -> email -> 'Attendee'.
--
-- 2. Deploy get_admin_profiles RPC:
--    - Direct, high-performance PostgreSQL RPC for admin portal user management.
--    - Avoids edge-function network roundtrips, cold starts, and Kong header issues.
--    - Gated strictly by public.is_admin_user().
-- ============================================================================

-- 1. Fix get_admin_financial_statement RPC
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
      COALESCE(
        NULLIF(TRIM(COALESCE(prof.first_name, '') || ' ' || COALESCE(prof.last_name, '')), ''),
        NULLIF(prof.username, ''),
        prof.email,
        'Attendee'
      ) AS attendee_name,
      prof.email AS attendee_email,
      NULL::TEXT AS attendee_phone,
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
      COALESCE(
        NULLIF(TRIM(COALESCE(prof.first_name, '') || ' ' || COALESCE(prof.last_name, '')), ''),
        NULLIF(prof.username, ''),
        prof.email,
        'Attendee'
      ) AS attendee_name,
      prof.email AS attendee_email,
      NULL::TEXT AS attendee_phone,
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
      COALESCE(cb.account_holder, 'Beneficiary') AS attendee_name,
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

-- 2. Deploy get_admin_profiles RPC
CREATE OR REPLACE FUNCTION public.get_admin_profiles(
  p_include_deleted BOOLEAN DEFAULT FALSE,
  p_deleted_only BOOLEAN DEFAULT FALSE,
  p_scheduled_only BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  id UUID,
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  avatar_url TEXT,
  is_admin BOOLEAN,
  created_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  deletion_grace_started_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    p.id,
    p.email,
    p.first_name,
    p.last_name,
    p.username,
    p.avatar_url,
    p.is_admin,
    p.created_at,
    p.deleted_at,
    p.deletion_grace_started_at
  FROM public.profiles p
  WHERE public.is_admin_user()
    AND (
      CASE
        WHEN p_scheduled_only THEN (p.deleted_at IS NULL AND p.deletion_grace_started_at IS NOT NULL)
        WHEN p_deleted_only THEN (p.deleted_at IS NOT NULL)
        WHEN NOT p_include_deleted THEN (p.deleted_at IS NULL AND p.deletion_grace_started_at IS NULL)
        ELSE TRUE
      END
    )
  ORDER BY p.created_at DESC;
$$;

REVOKE ALL ON FUNCTION public.get_admin_profiles(BOOLEAN, BOOLEAN, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_profiles(BOOLEAN, BOOLEAN, BOOLEAN) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_admin_profiles(BOOLEAN, BOOLEAN, BOOLEAN) IS
  'Admin-only directory of all profiles with email and is_admin, filtered by deletion/grace status.';
