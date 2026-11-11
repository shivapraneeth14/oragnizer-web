-- ============================================================================
-- CHIGZO — Restrict community financial reads to owner + organizer (+ admin)
--
-- Moderators previously inherited financial read access through
-- is_community_team(...), which includes MODERATOR. This adds
-- is_community_finance_reader() (owner / ORGANIZER member / admin) and uses it
-- in both financial RPCs so a moderator can no longer read wallet/financials.
-- Bodies are otherwise unchanged from their latest definitions.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_community_finance_reader(p_community_id UUID)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.communities c
    WHERE c.id = p_community_id AND c.owner_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.community_members cm
    WHERE cm.community_id = p_community_id
      AND cm.user_id = auth.uid()
      AND cm.role IN ('OWNER', 'ORGANIZER')
  ) OR public.is_admin_user();
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.is_community_finance_reader(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_community_finance_reader(UUID) TO authenticated, service_role;

-- get_community_financials (latest body from 202610290005, narrower gate)
CREATE OR REPLACE FUNCTION public.get_community_financials(p_community_id uuid)
RETURNS TABLE (
  wallet_balance integer,
  cashfree_beneficiary_id text,
  razorpay_account_id text,
  razorpay_account_status text,
  platform_fee_amount integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    c.wallet_balance,
    c.cashfree_beneficiary_id,
    NULL::text AS razorpay_account_id,
    NULL::text AS razorpay_account_status,
    c.platform_fee_amount
  FROM public.communities c
  WHERE c.id = p_community_id
    AND public.is_community_finance_reader(c.id);
$$;

REVOKE ALL ON FUNCTION public.get_community_financials(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_community_financials(uuid) TO authenticated, service_role;

-- get_organizer_financial_statement (latest body from 202611070004, narrower gate)
CREATE OR REPLACE FUNCTION public.get_organizer_financial_statement(
  p_community_id UUID,
  p_event_id UUID DEFAULT NULL::UUID
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT public.is_community_finance_reader(p_community_id) THEN
    RAISE EXCEPTION 'Unauthorized: Only community organizers and team can view community financials.';
  END IF;

  WITH deduped_prh AS (
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
      COALESCE(s.gross_amount, d.payment_amount, p.amount, d.amount) AS gross_amount,
      COALESCE(d.platform_fee, 0) AS platform_fee,
      COALESCE(
        NULLIF(d.organizer_clawed, 0),
        GREATEST(0, LEAST(
          d.amount,
          COALESCE(s.ticket_amount, p.organizer_share, 0)
          - COALESCE(SUM(
              d.amount
            ) OVER (
              PARTITION BY COALESCE(d.sale_id, d.payment_id)
              ORDER BY d.created_at, d.id
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ), 0)
        ))
      )::INTEGER AS organizer_share,
      0::INTEGER AS money_in,
      COALESCE(
        NULLIF(d.organizer_clawed, 0),
        GREATEST(0, LEAST(
          d.amount,
          COALESCE(s.ticket_amount, p.organizer_share, 0)
          - COALESCE(SUM(
              d.amount
            ) OVER (
              PARTITION BY COALESCE(d.sale_id, d.payment_id)
              ORDER BY d.created_at, d.id
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ), 0)
        ))
      )::INTEGER AS money_out,
      0::INTEGER AS wallet_debit_amount,
      0::INTEGER AS reserved_amount,
      NULL::UUID AS replaces_payout_id,
      d.refund_reason AS refund_reason,
      NULL::TEXT AS admin_notes,
      'razorpay'::TEXT AS payment_method,
      NULL::JSONB AS bank_details,
      NULL::TIMESTAMPTZ AS confirmed_at,
      NULL::TEXT AS resolution_notes,
      NULL::TIMESTAMPTZ AS resolved_at
    FROM deduped_prh d
    JOIN public.registrations r ON r.id = d.registration_id
    JOIN public.events e ON e.id = d.event_id
    LEFT JOIN public.payments p ON p.id = d.payment_id
    LEFT JOIN public.payment_sales s ON s.id = d.sale_id
    LEFT JOIN public.profiles prof ON prof.id = r.user_id
    WHERE e.community_id = p_community_id
      AND (p_event_id IS NULL OR d.event_id = p_event_id)
      AND (
        -- A refund recorded in the immutable ledger is real, even after the
        -- mutable payment row was re-quoted for a newer sale (its status is
        -- then 'success'/'pending', not 'refunded') and even when the wallet
        -- clawback is still pending (there is no wallet_debited audit row yet).
        -- Legacy rows without a sale link still use the original heuristic.
        d.sale_id IS NOT NULL
        OR p.status = 'refunded'
        OR EXISTS (
          SELECT 1 FROM public.payment_audit_log pal
          WHERE pal.action = 'wallet_debited'
            AND (pal.details->>'community_id')::UUID = p_community_id
            AND ((pal.details->>'event_id')::UUID = d.event_id OR pal.payment_id = d.payment_id)
        )
      )
  ),
  raw_transactions AS (
    -- Flow 1: Confirmed Ticket Sales (immutable payment_sales ledger)
    SELECT
      s.captured_at AS created_at,
      s.id AS transaction_id,
      'ticket_sale'::TEXT AS transaction_type,
      'success'::TEXT AS status,
      'Ticket Purchase'::TEXT AS description,
      s.razorpay_payment_id AS reference_id,
      s.razorpay_order_id AS secondary_ref,
      COALESCE(
        NULLIF(TRIM(COALESCE(prof.first_name, '') || ' ' || COALESCE(prof.last_name, '')), ''),
        NULLIF(prof.username, ''),
        prof.email,
        'Attendee'
      ) AS attendee_name,
      prof.email AS attendee_email,
      NULL::TEXT AS attendee_phone,
      r.id AS registration_id,
      s.event_id AS event_id,
      e.title AS event_title,
      CASE
        WHEN r.checked_in THEN 'Attended'
        WHEN r.status = 'cancelled' THEN 'Cancelled'
        ELSE 'Confirmed'
      END AS check_in_status,
      s.gross_amount AS gross_amount,
      s.platform_fee AS platform_fee,
      s.ticket_amount AS organizer_share,
      s.ticket_amount AS money_in,
      0::INTEGER AS money_out,
      0::INTEGER AS wallet_debit_amount,
      0::INTEGER AS reserved_amount,
      NULL::UUID AS replaces_payout_id,
      NULL::TEXT AS refund_reason,
      NULL::TEXT AS admin_notes,
      'razorpay'::TEXT AS payment_method,
      NULL::JSONB AS bank_details,
      NULL::TIMESTAMPTZ AS confirmed_at,
      NULL::TEXT AS resolution_notes,
      NULL::TIMESTAMPTZ AS resolved_at
    FROM public.payment_sales s
    JOIN public.registrations r ON r.id = s.registration_id
    JOIN public.events e ON e.id = s.event_id
    LEFT JOIN public.profiles prof ON prof.id = s.user_id
    WHERE s.community_id = p_community_id
      AND (p_event_id IS NULL OR s.event_id = p_event_id)

    UNION ALL

    -- Flow 2: Verified Customer Refunds
    SELECT * FROM calculated_refunds

    UNION ALL

    -- Flow 3: Manual Payouts & Transfers
    SELECT
      pi.created_at,
      pi.id AS transaction_id,
      CASE
        WHEN pi.status = 'success' THEN 'payout_confirmed'
        WHEN pi.status = 'disputed' THEN 'payout_disputed'
        WHEN pi.status = 'cancelled' THEN 'payout_cancelled'
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
      CASE
        WHEN pi.status = 'success' THEN pi.amount
        ELSE 0 END AS wallet_debit_amount,
      CASE
        WHEN pi.status IN ('pending_confirmation', 'disputed') THEN pi.amount
        ELSE 0 END AS reserved_amount,
      pi.replaces_payout_id AS replaces_payout_id,
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
      pi.confirmed_at AS confirmed_at,
      pi.resolution_notes AS resolution_notes,
      pi.resolved_at AS resolved_at
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
      ) OVER (ORDER BY rt.created_at ASC, rt.transaction_id ASC) AS running_balance
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
      'wallet_debit_amount', COALESCE(w.wallet_debit_amount, 0),
      'reserved_amount', COALESCE(w.reserved_amount, 0),
      'replaces_payout_id', w.replaces_payout_id,
      'running_balance', w.running_balance,
      'refund_reason', w.refund_reason,
      'admin_notes', w.admin_notes,
      'payment_method', w.payment_method,
      'bank_details', w.bank_details,
      'confirmed_at', w.confirmed_at,
      'resolution_notes', w.resolution_notes,
      'resolved_at', w.resolved_at
    )
    ORDER BY w.created_at DESC
  ) INTO v_result
  FROM with_running_balance w;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_organizer_financial_statement(UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_organizer_financial_statement(UUID, UUID)
  TO authenticated, service_role;
