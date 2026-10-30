-- ============================================================================
-- CLUVO — Organizer Financial Statement, Passbook, and Payout Dispute RPC
--
-- 1. Deploy organizer_dispute_manual_payout RPC:
--    - Allows community owner to mark a pending payout as disputed with a reason.
--    - Does NOT deduct wallet balance.
--    - Audits action to payment_audit_log.
--
-- 2. Deploy get_organizer_financial_statement RPC:
--    - Unified financial passbook for community organizers and moderators.
--    - Returns ticket sales, refunds, and payouts (both event-scoped and wallet-wide).
--    - Authorized strictly to community owner and team members.
-- ============================================================================

-- 1. Deploy organizer_dispute_manual_payout RPC
CREATE OR REPLACE FUNCTION public.organizer_dispute_manual_payout(
  p_payout_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payout RECORD;
BEGIN
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A reason is required to dispute a payout.');
  END IF;

  SELECT pi.* INTO v_payout
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payout record not found.');
  END IF;

  -- Authorization check: Caller must be the community owner
  IF NOT (public.is_community_owner(v_payout.community_id) OR public.is_admin_user()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not authorized to dispute this payout.');
  END IF;

  IF v_payout.status != 'pending_confirmation' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only payouts in pending confirmation state can be disputed.');
  END IF;

  -- Mark payout as disputed without deducting wallet
  UPDATE public.payout_items
  SET status = 'disputed',
      dispute_reason = TRIM(p_reason),
      confirmed_by_user = auth.uid(),
      confirmed_at = now()
  WHERE id = p_payout_id;

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('payout_disputed', jsonb_build_object(
    'payout_id', p_payout_id,
    'community_id', v_payout.community_id,
    'event_id', v_payout.event_id,
    'amount', v_payout.amount,
    'utr', v_payout.utr,
    'dispute_reason', TRIM(p_reason),
    'user_id', auth.uid()
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'payout_id', p_payout_id,
    'amount', v_payout.amount,
    'status', 'disputed'
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.organizer_dispute_manual_payout(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.organizer_dispute_manual_payout(UUID, TEXT) TO authenticated, service_role;

-- 2. Deploy get_organizer_financial_statement RPC
CREATE OR REPLACE FUNCTION public.get_organizer_financial_statement(
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
  -- Strict privilege check: must be community owner or team
  IF NOT (public.is_community_owner(p_community_id) OR public.is_community_team(p_community_id) OR public.is_admin_user()) THEN
    RAISE EXCEPTION 'Unauthorized: Only community organizers and team can view community financials.';
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
      ('Payout → ' || COALESCE(cb.label, cb.account_holder, 'Settlement'))::TEXT AS description,
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
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'created_at', t.created_at,
      'transaction_id', t.transaction_id,
      'transaction_type', t.transaction_type,
      'status', t.status,
      'description', t.description,
      'reference_id', t.reference_id,
      'secondary_ref', t.secondary_ref,
      'attendee_name', t.attendee_name,
      'attendee_email', t.attendee_email,
      'attendee_phone', t.attendee_phone,
      'registration_id', t.registration_id,
      'event_id', t.event_id,
      'event_title', t.event_title,
      'check_in_status', t.check_in_status,
      'gross_amount', t.gross_amount,
      'platform_fee', t.platform_fee,
      'organizer_share', t.organizer_share,
      'money_in', t.money_in,
      'money_out', t.money_out,
      'refund_reason', t.refund_reason,
      'admin_notes', t.admin_notes,
      'payment_method', t.payment_method,
      'bank_details', t.bank_details,
      'confirmed_at', t.confirmed_at
    )
    ORDER BY t.created_at DESC
  ), '[]'::JSONB)
  INTO v_result
  FROM raw_transactions t;

  RETURN v_result;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_organizer_financial_statement(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_organizer_financial_statement(UUID, UUID) TO authenticated, service_role;

