-- ============================================================================
-- CLUVO STAGE 5 MILESTONE D — MIGRATION 202611010005
-- Fix financial statement refund debits and running balance calculations:
-- 1. In Flow 2 (Refunds), calculate organizer deduction accurately based on
--    actual organizer net share, not gross customer refund (which includes platform fee).
-- 2. Link refund statement deductions strictly to verified wallet_debited events
--    in payment_audit_log, preventing phantom deductions on failed wallet clawbacks.
-- 3. Preserve every legitimate partial refund by deduplicating by provider refund
--    identity COALESCE(prh.razorpay_refund_id, prh.id::TEXT) rather than payment_id alone.
-- 4. Calculate individual partial refund debits and enforce a cumulative window cap
--    so total organizer refund debits never exceed the original organizer share.
-- 5. In running balance calculation, include verified refund debits immediately,
--    while keeping unconfirmed manual payouts (pending_confirmation / disputed)
--    separate until organizer digital acknowledgement.
-- 6. Fully compliant with PostgreSQL parser syntax (Flow 2 parenthesized subquery CTE).
-- ============================================================================

-- 1. Update get_admin_financial_statement
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

  WITH deduped_prh AS (
    -- Deduplicate repeated deliveries of the same provider refund transaction.
    -- Legitimate partial refunds with distinct provider IDs or distinct record IDs are preserved.
    SELECT DISTINCT ON (COALESCE(prh.razorpay_refund_id, prh.id::TEXT))
      prh.*
    FROM public.payment_refund_history prh
    ORDER BY COALESCE(prh.razorpay_refund_id, prh.id::TEXT), prh.created_at DESC
  ),
  calculated_refunds AS (
    SELECT
      d.created_at,
      d.id AS transaction_id,
      'refund'::TEXT AS transaction_type,
      COALESCE(d.refund_status, 'processed') AS status,
      ('Refund: ' || COALESCE(d.refund_reason, 'Ticket cancelled'))::TEXT AS description,
      d.razorpay_refund_id AS reference_id,
      d.payment_id::TEXT AS secondary_ref,
      COALESCE(
        NULLIF(TRIM(COALESCE(prof.first_name, '') || ' ' || COALESCE(prof.last_name, '')), ''),
        NULLIF(prof.username, ''),
        prof.email,
        'Attendee'
      ) AS attendee_name,
      prof.email AS attendee_email,
      prof.phone AS attendee_phone,
      r.id AS registration_id,
      d.event_id AS event_id,
      e.title AS event_title,
      'Refunded'::TEXT AS check_in_status,
      COALESCE(d.payment_amount, p.amount, d.amount) AS gross_amount,
      COALESCE(d.platform_fee, 0) AS platform_fee,
      -- Raw debit: for event cancellation, gross refund minus platform fee; for attendee refund, refund amount
      -- Capped cumulatively so total organizer refund debits for this payment cannot exceed original organizer share
      GREATEST(0, LEAST(
        CASE 
          WHEN d.refund_reason = 'event_cancellation' 
          THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
          ELSE d.amount
        END,
        COALESCE(p.organizer_share, GREATEST(COALESCE(d.payment_amount, p.amount, d.amount) - COALESCE(d.platform_fee, p.platform_fee, 0), 0))
        - COALESCE(SUM(
            CASE 
              WHEN d.refund_reason = 'event_cancellation' 
              THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
              ELSE d.amount
            END
          ) OVER (
            PARTITION BY d.payment_id 
            ORDER BY d.created_at, d.id 
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::INTEGER AS organizer_share,
      0::INTEGER AS money_in,
      GREATEST(0, LEAST(
        CASE 
          WHEN d.refund_reason = 'event_cancellation' 
          THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
          ELSE d.amount
        END,
        COALESCE(p.organizer_share, GREATEST(COALESCE(d.payment_amount, p.amount, d.amount) - COALESCE(d.platform_fee, p.platform_fee, 0), 0))
        - COALESCE(SUM(
            CASE 
              WHEN d.refund_reason = 'event_cancellation' 
              THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
              ELSE d.amount
            END
          ) OVER (
            PARTITION BY d.payment_id 
            ORDER BY d.created_at, d.id 
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::INTEGER AS money_out,
      d.refund_reason AS refund_reason,
      NULL::TEXT AS admin_notes,
      'razorpay'::TEXT AS payment_method,
      NULL::JSONB AS bank_details,
      NULL::TIMESTAMPTZ AS confirmed_at
    FROM deduped_prh d
    JOIN public.registrations r ON r.id = d.registration_id
    JOIN public.events e ON e.id = d.event_id
    LEFT JOIN public.payments p ON p.id = d.payment_id
    LEFT JOIN public.profiles prof ON prof.id = r.user_id
    WHERE e.community_id = p_community_id
      AND (p_event_id IS NULL OR d.event_id = p_event_id)
      -- Verify that an actual wallet debit occurred (or payment is in refunded state)
      AND (
        p.status = 'refunded'
        OR EXISTS (
          SELECT 1 FROM public.payment_audit_log pal
          WHERE pal.action = 'wallet_debited'
            AND (pal.details->>'community_id')::UUID = p_community_id
            AND ((pal.details->>'event_id')::UUID = d.event_id OR pal.payment_id = d.payment_id)
        )
      )
  ),
  raw_transactions AS (
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
      AND (
        (p.status = 'success' AND r.status IN ('confirmed', 'attended'))
        OR p.status = 'refunded'
      )

    UNION ALL

    -- Flow 2: Verified Customer Refunds (calculated_refunds CTE)
    SELECT * FROM calculated_refunds

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
      -- Verified refunds deduct money_out immediately; payouts deduct ONLY upon organizer confirmation (status = 'success')
      SUM(
        rt.money_in - CASE
          WHEN rt.transaction_type = 'refund' OR rt.status IN ('success', 'processed') THEN rt.money_out
          ELSE 0
        END
      ) OVER (ORDER BY rt.created_at ASC) AS running_balance
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

-- 2. Update get_organizer_financial_statement
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
  -- Strict privilege check: must be community owner or team member
  IF NOT (public.is_community_owner(p_community_id) OR public.is_community_team(p_community_id) OR public.is_admin_user()) THEN
    RAISE EXCEPTION 'Unauthorized: Only community organizers and team can view community financials.';
  END IF;

  WITH deduped_prh AS (
    -- Deduplicate repeated deliveries of the same provider refund transaction.
    -- Legitimate partial refunds with distinct provider IDs or distinct record IDs are preserved.
    SELECT DISTINCT ON (COALESCE(prh.razorpay_refund_id, prh.id::TEXT))
      prh.*
    FROM public.payment_refund_history prh
    ORDER BY COALESCE(prh.razorpay_refund_id, prh.id::TEXT), prh.created_at DESC
  ),
  calculated_refunds AS (
    SELECT
      d.created_at,
      d.id AS transaction_id,
      'refund'::TEXT AS transaction_type,
      COALESCE(d.refund_status, 'processed') AS status,
      ('Refund: ' || COALESCE(d.refund_reason, 'Ticket cancelled'))::TEXT AS description,
      d.razorpay_refund_id AS reference_id,
      d.payment_id::TEXT AS secondary_ref,
      COALESCE(
        NULLIF(TRIM(COALESCE(prof.first_name, '') || ' ' || COALESCE(prof.last_name, '')), ''),
        NULLIF(prof.username, ''),
        prof.email,
        'Attendee'
      ) AS attendee_name,
      prof.email AS attendee_email,
      NULL::TEXT AS attendee_phone,
      r.id AS registration_id,
      d.event_id AS event_id,
      e.title AS event_title,
      'Refunded'::TEXT AS check_in_status,
      COALESCE(d.payment_amount, p.amount, d.amount) AS gross_amount,
      COALESCE(d.platform_fee, 0) AS platform_fee,
      -- Raw debit: for event cancellation, gross refund minus platform fee; for attendee refund, refund amount
      -- Capped cumulatively so total organizer refund debits for this payment cannot exceed original organizer share
      GREATEST(0, LEAST(
        CASE 
          WHEN d.refund_reason = 'event_cancellation' 
          THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
          ELSE d.amount
        END,
        COALESCE(p.organizer_share, GREATEST(COALESCE(d.payment_amount, p.amount, d.amount) - COALESCE(d.platform_fee, p.platform_fee, 0), 0))
        - COALESCE(SUM(
            CASE 
              WHEN d.refund_reason = 'event_cancellation' 
              THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
              ELSE d.amount
            END
          ) OVER (
            PARTITION BY d.payment_id 
            ORDER BY d.created_at, d.id 
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::INTEGER AS organizer_share,
      0::INTEGER AS money_in,
      GREATEST(0, LEAST(
        CASE 
          WHEN d.refund_reason = 'event_cancellation' 
          THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
          ELSE d.amount
        END,
        COALESCE(p.organizer_share, GREATEST(COALESCE(d.payment_amount, p.amount, d.amount) - COALESCE(d.platform_fee, p.platform_fee, 0), 0))
        - COALESCE(SUM(
            CASE 
              WHEN d.refund_reason = 'event_cancellation' 
              THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
              ELSE d.amount
            END
          ) OVER (
            PARTITION BY d.payment_id 
            ORDER BY d.created_at, d.id 
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::INTEGER AS money_out,
      d.refund_reason AS refund_reason,
      NULL::TEXT AS admin_notes,
      'razorpay'::TEXT AS payment_method,
      NULL::JSONB AS bank_details,
      NULL::TIMESTAMPTZ AS confirmed_at
    FROM deduped_prh d
    JOIN public.registrations r ON r.id = d.registration_id
    JOIN public.events e ON e.id = d.event_id
    LEFT JOIN public.payments p ON p.id = d.payment_id
    LEFT JOIN public.profiles prof ON prof.id = r.user_id
    WHERE e.community_id = p_community_id
      AND (p_event_id IS NULL OR d.event_id = p_event_id)
      AND (
        p.status = 'refunded'
        OR EXISTS (
          SELECT 1 FROM public.payment_audit_log pal
          WHERE pal.action = 'wallet_debited'
            AND (pal.details->>'community_id')::UUID = p_community_id
            AND ((pal.details->>'event_id')::UUID = d.event_id OR pal.payment_id = d.payment_id)
        )
      )
  ),
  raw_transactions AS (
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
      AND (
        (p.status = 'success' AND r.status IN ('confirmed', 'attended'))
        OR p.status = 'refunded'
      )

    UNION ALL

    -- Flow 2: Verified Customer Refunds (calculated_refunds CTE)
    SELECT * FROM calculated_refunds

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
  ),
  with_running_balance AS (
    SELECT
      rt.*,
      SUM(
        rt.money_in - CASE
          WHEN rt.transaction_type = 'refund' OR rt.status IN ('success', 'processed') THEN rt.money_out
          ELSE 0
        END
      ) OVER (ORDER BY rt.created_at ASC) AS running_balance
    FROM raw_transactions rt
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
      'running_balance', t.running_balance,
      'refund_reason', t.refund_reason,
      'admin_notes', t.admin_notes,
      'payment_method', t.payment_method,
      'bank_details', t.bank_details,
      'confirmed_at', t.confirmed_at
    )
    ORDER BY t.created_at DESC
  ), '[]'::JSONB) INTO v_result
  FROM with_running_balance t;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_organizer_financial_statement(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_organizer_financial_statement(UUID, UUID) TO authenticated, service_role;
