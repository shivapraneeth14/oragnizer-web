-- ============================================================================
-- CLUVO — Refund policy: fee kept on confirmed refunds (statement math)
--
-- The refund-debit CASE subtracted platform_fee for event_cancellation refunds
-- (the old "full refund incl. fee" model). Now a confirmed booking is refunded
-- the ticket price only, so the organizer refund debit is simply the refund
-- amount (d.amount), and a never-confirmed capture (organizer_share NULL) never
-- reduces organizer earnings. This mirrors the complete_payment_refund clawback.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.run_financial_reconciliation(p_community_id uuid DEFAULT NULL::uuid, p_batch_limit integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_is_authorized BOOLEAN;
  v_timestamp TIMESTAMPTZ := clock_timestamp();
  v_total_communities INTEGER := 0;
  v_clean_communities INTEGER := 0;
  v_discrepant_communities INTEGER := 0;
  v_total_payments INTEGER := 0;
  v_total_refunds INTEGER := 0;
  v_total_payouts INTEGER := 0;

  -- Global aggregates
  v_gross_revenue_paise BIGINT := 0;
  v_platform_fee_paise BIGINT := 0;
  v_organizer_share_paise BIGINT := 0;
  v_customer_refunds_paise BIGINT := 0;
  v_organizer_refund_debits_paise BIGINT := 0;
  v_confirmed_payouts_paise BIGINT := 0;
  v_pending_payouts_paise BIGINT := 0;
  v_disputed_payouts_paise BIGINT := 0;
  v_total_stored_wallet_paise BIGINT := 0;
  v_total_uncommitted_payable_paise BIGINT := 0;

  v_community_recon JSONB := '[]'::JSONB;
  v_payment_discrepancies JSONB := '[]'::JSONB;
  v_refund_discrepancies JSONB := '[]'::JSONB;
  v_settlement_discrepancies JSONB := '[]'::JSONB;
BEGIN
  -- Strict privilege check: Platform admin or service_role
  v_is_authorized := (
    public.is_admin_user()
    OR COALESCE((auth.jwt() ->> 'role'), '') = 'service_role'
    OR current_setting('request.jwt.claim.role', true) = 'service_role'
    OR current_user = 'service_role'
  );

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can run financial reconciliation.';
  END IF;

  -- --------------------------------------------------------------------------
  -- 1. THREE-WAY WALLET RECONCILIATION PER COMMUNITY
  -- --------------------------------------------------------------------------
  WITH target_communities AS (
    SELECT c.id, c.name, COALESCE(c.wallet_balance, 0) AS stored_wallet
    FROM public.communities c
    WHERE (p_community_id IS NULL OR c.id = p_community_id)
    ORDER BY c.name ASC
    LIMIT p_batch_limit
  ),
  community_audit_credits AS (
    SELECT
      (pal.details->>'community_id')::UUID AS comm_id,
      COALESCE(SUM((pal.details->>'amount')::BIGINT), 0) AS total_credits
    FROM public.payment_audit_log pal
    WHERE pal.action IN ('wallet_credited', 'payout_stuck_refunded', 'wallet_refunded')
      AND pal.details->>'community_id' IS NOT NULL
      AND (p_community_id IS NULL OR (pal.details->>'community_id')::UUID = p_community_id)
    GROUP BY (pal.details->>'community_id')::UUID
  ),
  community_audit_debits AS (
    SELECT
      (pal.details->>'community_id')::UUID AS comm_id,
      COALESCE(SUM((pal.details->>'amount')::BIGINT), 0) AS total_debits
    FROM public.payment_audit_log pal
    WHERE pal.action = 'wallet_debited'
      AND pal.details->>'community_id' IS NOT NULL
      AND (p_community_id IS NULL OR (pal.details->>'community_id')::UUID = p_community_id)
    GROUP BY (pal.details->>'community_id')::UUID
  ),
  community_sales_earned AS (
    SELECT
      (pal.details->>'community_id')::UUID AS comm_id,
      COALESCE(SUM((pal.details->>'amount')::BIGINT), 0) AS organizer_sales_earned
    FROM public.payment_audit_log pal
    WHERE pal.action = 'wallet_credited'
      AND pal.details->>'community_id' IS NOT NULL
      AND (p_community_id IS NULL OR (pal.details->>'community_id')::UUID = p_community_id)
    GROUP BY (pal.details->>'community_id')::UUID
  ),
  community_primary_sales AS (
    SELECT
      e.community_id AS comm_id,
      COALESCE(SUM(COALESCE(p.organizer_share, GREATEST(p.amount - COALESCE(p.platform_fee, 0), 0))), 0)::BIGINT AS organizer_sales_earned,
      COALESCE(SUM(p.amount), 0)::BIGINT AS gross_sales,
      COALESCE(SUM(COALESCE(p.platform_fee, 0)), 0)::BIGINT AS platform_fees_collected,
      COUNT(p.id) AS payment_count
    FROM public.payments p
    JOIN public.registrations r ON r.id = p.registration_id
    JOIN public.events e ON e.id = r.event_id
    WHERE (p_community_id IS NULL OR e.community_id = p_community_id)
      AND (
        (p.status = 'success' AND r.status IN ('confirmed', 'attended'))
        OR p.status = 'refunded'
      )
    GROUP BY e.community_id
  ),
  deduped_prh AS (
    -- Deduplicate repeated deliveries of the same provider refund transaction.
    -- Legitimate partial refunds with distinct provider IDs or distinct record IDs are preserved.
    SELECT DISTINCT ON (COALESCE(prh.razorpay_refund_id, prh.id::TEXT))
      prh.*
    FROM public.payment_refund_history prh
    ORDER BY COALESCE(prh.razorpay_refund_id, prh.id::TEXT), prh.created_at DESC
  ),
  calculated_refund_debits AS (
    SELECT
      d.id,
      d.payment_id,
      e.community_id AS comm_id,
      d.amount AS customer_refund_amount,
      -- Raw debit: for event cancellation, gross refund minus platform fee; for attendee refund, refund amount
      -- Capped cumulatively so total organizer refund debits for this payment cannot exceed original organizer share
      GREATEST(0, LEAST(
        d.amount,
        COALESCE(p.organizer_share, 0)
        - COALESCE(SUM(
            d.amount
          ) OVER (
            PARTITION BY d.payment_id
            ORDER BY d.created_at, d.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::BIGINT AS organizer_refund_debit
    FROM deduped_prh d
    JOIN public.events e ON e.id = d.event_id
    LEFT JOIN public.payments p ON p.id = d.payment_id
    WHERE (p_community_id IS NULL OR e.community_id = p_community_id)
      AND (
        p.status = 'refunded'
        OR EXISTS (
          SELECT 1 FROM public.payment_audit_log pal
          WHERE pal.action = 'wallet_debited'
            AND (pal.details->>'community_id')::UUID = e.community_id
            AND ((pal.details->>'event_id')::UUID = d.event_id OR pal.payment_id = d.payment_id)
        )
      )
  ),
  community_refund_totals AS (
    SELECT
      crd.comm_id,
      COALESCE(SUM(crd.customer_refund_amount), 0)::BIGINT AS total_customer_refunds,
      COALESCE(SUM(crd.organizer_refund_debit), 0)::BIGINT AS total_organizer_refund_debits,
      COUNT(crd.id) AS refund_count
    FROM calculated_refund_debits crd
    GROUP BY crd.comm_id
  ),
  community_payout_totals AS (
    SELECT
      pi.community_id AS comm_id,
      COALESCE(SUM(CASE WHEN pi.status = 'success' THEN pi.amount ELSE 0 END), 0)::BIGINT AS confirmed_payouts,
      COALESCE(SUM(CASE WHEN pi.status = 'pending_confirmation' THEN pi.amount ELSE 0 END), 0)::BIGINT AS pending_payouts,
      COALESCE(SUM(CASE WHEN pi.status = 'disputed' THEN pi.amount ELSE 0 END), 0)::BIGINT AS disputed_payouts,
      COUNT(pi.id) AS payout_count
    FROM public.payout_items pi
    WHERE (p_community_id IS NULL OR pi.community_id = p_community_id)
    GROUP BY pi.community_id
  ),
  community_reconciled AS (
    SELECT
      tc.id AS community_id,
      tc.name AS community_name,
      tc.stored_wallet::BIGINT AS stored_wallet_balance,
      (COALESCE(cac.total_credits, 0) - COALESCE(cad.total_debits, 0))::BIGINT AS audit_ledger_balance,
      (COALESCE(cse.organizer_sales_earned, 0) - COALESCE(crt.total_organizer_refund_debits, 0) - COALESCE(cpt.confirmed_payouts, 0))::BIGINT AS primary_transaction_balance,
      COALESCE(cpt.pending_payouts, 0)::BIGINT AS in_flight_pending_payouts,
      COALESCE(cpt.disputed_payouts, 0)::BIGINT AS disputed_payouts,
      GREATEST(0, (tc.stored_wallet - COALESCE(cpt.pending_payouts, 0) - COALESCE(cpt.disputed_payouts, 0)))::BIGINT AS uncommitted_wallet_balance,
      COALESCE(cps.gross_sales, 0)::BIGINT AS gross_sales,
      COALESCE(cps.platform_fees_collected, 0)::BIGINT AS platform_fees,
      COALESCE(cse.organizer_sales_earned, 0)::BIGINT AS organizer_sales_earned,
      COALESCE(crt.total_customer_refunds, 0)::BIGINT AS customer_refunds,
      COALESCE(crt.total_organizer_refund_debits, 0)::BIGINT AS organizer_refund_debits,
      COALESCE(cpt.confirmed_payouts, 0)::BIGINT AS confirmed_payouts,
      COALESCE(cps.payment_count, 0) AS payment_count,
      COALESCE(crt.refund_count, 0) AS refund_count,
      COALESCE(cpt.payout_count, 0) AS payout_count
    FROM target_communities tc
    LEFT JOIN community_audit_credits cac ON cac.comm_id = tc.id
    LEFT JOIN community_audit_debits cad ON cad.comm_id = tc.id
    LEFT JOIN community_primary_sales cps ON cps.comm_id = tc.id
    LEFT JOIN community_sales_earned cse ON cse.comm_id = tc.id
    LEFT JOIN community_refund_totals crt ON crt.comm_id = tc.id
    LEFT JOIN community_payout_totals cpt ON cpt.comm_id = tc.id
  ),
  evaluated_communities AS (
    SELECT
      cr.*,
      (cr.stored_wallet_balance - cr.audit_ledger_balance)::BIGINT AS stored_vs_ledger_diff,
      (cr.stored_wallet_balance - cr.primary_transaction_balance)::BIGINT AS stored_vs_primary_diff,
      (cr.audit_ledger_balance - cr.primary_transaction_balance)::BIGINT AS ledger_vs_primary_diff,
      CASE
        WHEN cr.stored_wallet_balance = cr.primary_transaction_balance
         AND cr.stored_wallet_balance = cr.audit_ledger_balance
         AND (cr.in_flight_pending_payouts + cr.disputed_payouts) <= cr.stored_wallet_balance
         AND cr.disputed_payouts = 0
        THEN 'CLEAN'
        ELSE 'DISCREPANCY'
      END AS status,
      ARRAY_REMOVE(ARRAY[
        CASE WHEN cr.stored_wallet_balance != cr.primary_transaction_balance THEN 'STORED_VS_PRIMARY_MISMATCH' END,
        CASE WHEN cr.stored_wallet_balance = cr.primary_transaction_balance AND cr.audit_ledger_balance != cr.stored_wallet_balance THEN 'LEGACY_UNAUDITED_CREDITS' END,
        CASE WHEN (cr.in_flight_pending_payouts + cr.disputed_payouts) > cr.stored_wallet_balance THEN 'LOCKED_PAYOUTS_EXCEED_WALLET' END,
        CASE WHEN cr.disputed_payouts > 0 THEN 'HAS_DISPUTED_PAYOUTS' END
      ], NULL) AS discrepancy_types
    FROM community_reconciled cr
  )
  SELECT
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'community_id', ec.community_id,
        'community_name', ec.community_name,
        'stored_wallet_balance', ec.stored_wallet_balance,
        'audit_ledger_balance', ec.audit_ledger_balance,
        'primary_transaction_balance', ec.primary_transaction_balance,
        'in_flight_pending_payouts', ec.in_flight_pending_payouts,
        'disputed_payouts', ec.disputed_payouts,
        'uncommitted_wallet_balance', ec.uncommitted_wallet_balance,
        'status', ec.status,
        'stored_vs_ledger_diff', ec.stored_vs_ledger_diff,
        'stored_vs_primary_diff', ec.stored_vs_primary_diff,
        'ledger_vs_primary_diff', ec.ledger_vs_primary_diff,
        'discrepancy_types', ec.discrepancy_types,
        'metrics', jsonb_build_object(
          'gross_sales', ec.gross_sales,
          'platform_fees', ec.platform_fees,
          'organizer_sales_earned', ec.organizer_sales_earned,
          'customer_refunds', ec.customer_refunds,
          'organizer_refund_debits', ec.organizer_refund_debits,
          'confirmed_payouts', ec.confirmed_payouts,
          'payment_count', ec.payment_count,
          'refund_count', ec.refund_count,
          'payout_count', ec.payout_count
        )
      )
      ORDER BY
        CASE WHEN ec.status = 'DISCREPANCY' THEN 0 ELSE 1 END,
        ec.community_name ASC
    ), '[]'::JSONB),
    COUNT(*),
    COUNT(*) FILTER (WHERE ec.status = 'CLEAN'),
    COUNT(*) FILTER (WHERE ec.status = 'DISCREPANCY'),
    COALESCE(SUM(ec.gross_sales), 0),
    COALESCE(SUM(ec.platform_fees), 0),
    COALESCE(SUM(ec.organizer_sales_earned), 0),
    COALESCE(SUM(ec.customer_refunds), 0),
    COALESCE(SUM(ec.organizer_refund_debits), 0),
    COALESCE(SUM(ec.confirmed_payouts), 0),
    COALESCE(SUM(ec.in_flight_pending_payouts), 0),
    COALESCE(SUM(ec.disputed_payouts), 0),
    COALESCE(SUM(ec.stored_wallet_balance), 0),
    COALESCE(SUM(ec.uncommitted_wallet_balance), 0),
    COALESCE(SUM(ec.payment_count), 0),
    COALESCE(SUM(ec.refund_count), 0),
    COALESCE(SUM(ec.payout_count), 0)
  INTO
    v_community_recon,
    v_total_communities,
    v_clean_communities,
    v_discrepant_communities,
    v_gross_revenue_paise,
    v_platform_fee_paise,
    v_organizer_share_paise,
    v_customer_refunds_paise,
    v_organizer_refund_debits_paise,
    v_confirmed_payouts_paise,
    v_pending_payouts_paise,
    v_disputed_payouts_paise,
    v_total_stored_wallet_paise,
    v_total_uncommitted_payable_paise,
    v_total_payments,
    v_total_refunds,
    v_total_payouts
  FROM evaluated_communities ec;

  -- --------------------------------------------------------------------------
  -- 2. PAYMENT DISCREPANCY AUDIT
  -- --------------------------------------------------------------------------
  WITH flagged_payments AS (
    -- 2.1 Orphan Payments (no registration)
    SELECT
      p.id AS payment_id,
      p.razorpay_payment_id,
      p.amount,
      p.status,
      'ORPHAN_PAYMENT' AS discrepancy_type,
      'Payment record exists without a corresponding registration' AS discrepancy_details,
      NULL::UUID AS community_id,
      p.created_at
    FROM public.payments p
    WHERE p.registration_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.registrations r WHERE r.id = p.registration_id)

    UNION ALL

    -- 2.2 Payment Without Confirmed Registration
    SELECT
      p.id AS payment_id,
      p.razorpay_payment_id,
      p.amount,
      p.status,
      'PAYMENT_WITHOUT_CONFIRMED_REGISTRATION' AS discrepancy_type,
      ('Payment marked success but registration status is ' || COALESCE(r.status, 'missing')) AS discrepancy_details,
      e.community_id,
      p.created_at
    FROM public.payments p
    JOIN public.registrations r ON r.id = p.registration_id
    JOIN public.events e ON e.id = r.event_id
    WHERE p.status = 'success'
      AND r.status NOT IN ('confirmed', 'attended', 'cancelled')
      AND (p_community_id IS NULL OR e.community_id = p_community_id)

    UNION ALL

    -- 2.3 Duplicate Payment IDs
    SELECT
      p.id AS payment_id,
      p.razorpay_payment_id,
      p.amount,
      p.status,
      'DUPLICATE_PAYMENT_ID' AS discrepancy_type,
      ('Duplicate razorpay_payment_id reused across multiple payment rows: ' || p.razorpay_payment_id) AS discrepancy_details,
      e.community_id,
      p.created_at
    FROM public.payments p
    LEFT JOIN public.registrations r ON r.id = p.registration_id
    LEFT JOIN public.events e ON e.id = r.event_id
    WHERE p.razorpay_payment_id IS NOT NULL
      AND (p_community_id IS NULL OR e.community_id = p_community_id)
      AND EXISTS (
        SELECT 1 FROM public.payments p2
        WHERE p2.razorpay_payment_id = p.razorpay_payment_id
          AND p2.id <> p.id
      )

    UNION ALL

    -- 2.4 Currency Amount / Fee Split Mismatch
    SELECT
      p.id AS payment_id,
      p.razorpay_payment_id,
      p.amount,
      p.status,
      'SPLIT_AMOUNT_MISMATCH' AS discrepancy_type,
      ('Total amount ' || p.amount || ' != organizer_share ' || COALESCE(p.organizer_share, 0) || ' + platform_fee ' || COALESCE(p.platform_fee, 0)) AS discrepancy_details,
      e.community_id,
      p.created_at
    FROM public.payments p
    JOIN public.registrations r ON r.id = p.registration_id
    JOIN public.events e ON e.id = r.event_id
    WHERE (p.organizer_share IS NOT NULL OR p.platform_fee IS NOT NULL)
      AND p.amount <> (COALESCE(p.organizer_share, 0) + COALESCE(p.platform_fee, 0))
      AND (p_community_id IS NULL OR e.community_id = p_community_id)

    UNION ALL

    -- 2.5 Stuck Pending Payments (> 24 hours)
    SELECT
      p.id AS payment_id,
      p.razorpay_payment_id,
      p.amount,
      p.status,
      'STUCK_PENDING_PAYMENT' AS discrepancy_type,
      ('Payment pending for > 24 hours without capture or cleanup (created ' || to_char(p.created_at, 'YYYY-MM-DD HH24:MI:SS') || ')') AS discrepancy_details,
      e.community_id,
      p.created_at
    FROM public.payments p
    LEFT JOIN public.registrations r ON r.id = p.registration_id
    LEFT JOIN public.events e ON e.id = r.event_id
    WHERE p.status = 'pending'
      AND p.created_at < (clock_timestamp() - INTERVAL '24 hours')
      AND (p_community_id IS NULL OR e.community_id = p_community_id)

    UNION ALL

    -- 2.6 Legacy Unpartitioned Payment Splits
    SELECT
      p.id AS payment_id,
      p.razorpay_payment_id,
      p.amount,
      p.status,
      'LEGACY_UNPARTITIONED_SPLIT' AS discrepancy_type,
      'Payment confirmed without persisted checkout-time split columns (platform_fee or organizer_share NULL)' AS discrepancy_details,
      e.community_id,
      p.created_at
    FROM public.payments p
    JOIN public.registrations r ON r.id = p.registration_id
    JOIN public.events e ON e.id = r.event_id
    WHERE p.status = 'success'
      AND (p.platform_fee IS NULL OR p.organizer_share IS NULL)
      AND (p_community_id IS NULL OR e.community_id = p_community_id)
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'payment_id', fp.payment_id,
      'razorpay_payment_id', fp.razorpay_payment_id,
      'amount', fp.amount,
      'status', fp.status,
      'discrepancy_type', fp.discrepancy_type,
      'discrepancy_details', fp.discrepancy_details,
      'community_id', fp.community_id,
      'created_at', fp.created_at
    )
    ORDER BY fp.created_at DESC
  ), '[]'::JSONB)
  INTO v_payment_discrepancies
  FROM flagged_payments fp;

  -- --------------------------------------------------------------------------
  -- 3. REFUND DISCREPANCY AUDIT
  -- --------------------------------------------------------------------------
  WITH flagged_refunds AS (
    -- 3.1 Orphan Refund History
    SELECT
      prh.id AS refund_history_id,
      prh.payment_id,
      prh.razorpay_refund_id,
      prh.amount,
      'ORPHAN_REFUND' AS discrepancy_type,
      'Refund history record without corresponding payment row' AS discrepancy_details,
      prh.created_at
    FROM public.payment_refund_history prh
    WHERE prh.payment_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.payments p WHERE p.id = prh.payment_id)

    UNION ALL

    -- 3.2 Refund Exceeding Payment Amount
    SELECT
      prh.id AS refund_history_id,
      prh.payment_id,
      prh.razorpay_refund_id,
      prh.amount,
      'REFUND_EXCEEDING_PAYMENT' AS discrepancy_type,
      ('Refund amount ' || prh.amount || ' exceeds original payment amount ' || p.amount) AS discrepancy_details,
      prh.created_at
    FROM public.payment_refund_history prh
    JOIN public.payments p ON p.id = prh.payment_id
    LEFT JOIN public.events e ON e.id = prh.event_id
    WHERE prh.amount > p.amount
      AND (p_community_id IS NULL OR e.community_id = p_community_id)

    UNION ALL

    -- 3.3 Duplicate Refund Reference ID
    SELECT
      prh.id AS refund_history_id,
      prh.payment_id,
      prh.razorpay_refund_id,
      prh.amount,
      'DUPLICATE_REFUND_ID' AS discrepancy_type,
      ('Duplicate razorpay_refund_id reused: ' || prh.razorpay_refund_id) AS discrepancy_details,
      prh.created_at
    FROM public.payment_refund_history prh
    LEFT JOIN public.events e ON e.id = prh.event_id
    WHERE prh.razorpay_refund_id IS NOT NULL
      AND (p_community_id IS NULL OR e.community_id = p_community_id)
      AND EXISTS (
        SELECT 1 FROM public.payment_refund_history prh2
        WHERE prh2.razorpay_refund_id = prh.razorpay_refund_id
          AND prh2.id <> prh.id
      )

    UNION ALL

    -- 3.4 Stuck Pending / Failed Cancellation Queue Tasks
    SELECT
      rtq.id AS refund_history_id,
      rtq.payment_id,
      rtq.razorpay_refund_id,
      rtq.amount,
      ('CANCELLATION_QUEUE_' || UPPER(rtq.status)) AS discrepancy_type,
      ('Queue task stuck or exhausted retries: attempt ' || rtq.attempt_count || '/' || rtq.max_attempts || ' — ' || COALESCE(rtq.error_message, 'no error logged')) AS discrepancy_details,
      rtq.created_at
    FROM public.refund_task_queue rtq
    LEFT JOIN public.events e ON e.id = rtq.event_id
    WHERE (
        rtq.status IN ('failed', 'uncertain', 'manual_review')
        OR (rtq.status = 'pending' AND rtq.created_at < (clock_timestamp() - INTERVAL '24 hours'))
        OR rtq.attempt_count >= rtq.max_attempts
      )
      AND (p_community_id IS NULL OR e.community_id = p_community_id)
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'refund_history_id', fr.refund_history_id,
      'payment_id', fr.payment_id,
      'razorpay_refund_id', fr.razorpay_refund_id,
      'amount', fr.amount,
      'discrepancy_type', fr.discrepancy_type,
      'discrepancy_details', fr.discrepancy_details,
      'created_at', fr.created_at
    )
    ORDER BY fr.created_at DESC
  ), '[]'::JSONB)
  INTO v_refund_discrepancies
  FROM flagged_refunds fr;

  -- --------------------------------------------------------------------------
  -- 4. SETTLEMENT DISCREPANCY AUDIT
  -- --------------------------------------------------------------------------
  WITH flagged_settlements AS (
    -- 4.1 Pending Payouts Exceeding Current Wallet Balance
    SELECT
      pi.id AS settlement_id,
      pi.community_id,
      pi.event_id,
      pi.amount,
      pi.status,
      pi.utr,
      'PENDING_EXCEEDS_WALLET' AS discrepancy_type,
      ('In-flight pending payout ' || pi.amount || ' exceeds current community wallet ' || c.wallet_balance) AS discrepancy_details,
      pi.created_at
    FROM public.payout_items pi
    JOIN public.communities c ON c.id = pi.community_id
    WHERE pi.status = 'pending_confirmation'
      AND pi.amount > c.wallet_balance
      AND (p_community_id IS NULL OR pi.community_id = p_community_id)

    UNION ALL

    -- 4.2 Disputed Manual Payouts
    SELECT
      pi.id AS settlement_id,
      pi.community_id,
      pi.event_id,
      pi.amount,
      pi.status,
      pi.utr,
      'DISPUTED_PAYOUT' AS discrepancy_type,
      ('Payout disputed by organizer: ' || COALESCE(pi.dispute_reason, 'No reason specified')) AS discrepancy_details,
      pi.created_at
    FROM public.payout_items pi
    WHERE pi.status = 'disputed'
      AND (p_community_id IS NULL OR pi.community_id = p_community_id)

    UNION ALL

    -- 4.3 Duplicate Active UTRs on the Same Community / Event
    SELECT
      pi1.id AS settlement_id,
      pi1.community_id,
      pi1.event_id,
      pi1.amount,
      pi1.status,
      pi1.utr,
      'DUPLICATE_ACTIVE_UTR' AS discrepancy_type,
      ('UTR ' || pi1.utr || ' is recorded across multiple active payout items for this event/community') AS discrepancy_details,
      pi1.created_at
    FROM public.payout_items pi1
    JOIN public.payout_items pi2 ON pi2.utr = pi1.utr
      AND pi2.community_id = pi1.community_id
      AND pi2.event_id IS NOT DISTINCT FROM pi1.event_id
      AND pi2.id <> pi1.id
    WHERE pi1.status <> 'disputed'
      AND pi2.status <> 'disputed'
      AND (p_community_id IS NULL OR pi1.community_id = p_community_id)
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'settlement_id', fs.settlement_id,
      'community_id', fs.community_id,
      'event_id', fs.event_id,
      'amount', fs.amount,
      'status', fs.status,
      'utr', fs.utr,
      'discrepancy_type', fs.discrepancy_type,
      'discrepancy_details', fs.discrepancy_details,
      'created_at', fs.created_at
    )
    ORDER BY fs.created_at DESC
  ), '[]'::JSONB)
  INTO v_settlement_discrepancies
  FROM flagged_settlements fs;

  -- --------------------------------------------------------------------------
  -- 5. ASSEMBLE FINAL AUDIT REPORT
  -- --------------------------------------------------------------------------
  RETURN jsonb_build_object(
    'reconciliation_timestamp', v_timestamp,
    'summary', jsonb_build_object(
      'total_communities_audited', v_total_communities,
      'clean_communities_count', v_clean_communities,
      'discrepant_communities_count', v_discrepant_communities,
      'total_payments_audited', v_total_payments,
      'total_refunds_audited', v_total_refunds,
      'total_payouts_audited', v_total_payouts,
      'total_discrepancies_found', (
        v_discrepant_communities +
        jsonb_array_length(v_payment_discrepancies) +
        jsonb_array_length(v_refund_discrepancies) +
        jsonb_array_length(v_settlement_discrepancies)
      )
    ),
    'settlement_overview', jsonb_build_object(
      'gross_revenue_paise', v_gross_revenue_paise,
      'platform_fee_paise', v_platform_fee_paise,
      'organizer_share_paise', v_organizer_share_paise,
      'customer_refunds_paise', v_customer_refunds_paise,
      'organizer_refund_debits_paise', v_organizer_refund_debits_paise,
      'confirmed_payouts_paise', v_confirmed_payouts_paise,
      'pending_payouts_paise', v_pending_payouts_paise,
      'disputed_payouts_paise', v_disputed_payouts_paise,
      'total_stored_wallet_paise', v_total_stored_wallet_paise,
      'total_uncommitted_payable_paise', v_total_uncommitted_payable_paise
    ),
    'three_way_wallet_reconciliation', v_community_recon,
    'payment_discrepancies', v_payment_discrepancies,
    'refund_discrepancies', v_refund_discrepancies,
    'settlement_discrepancies', v_settlement_discrepancies
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_financial_statement(p_community_id uuid, p_event_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can view the full financial ledger.';
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
      COALESCE(d.payment_amount, p.amount, d.amount) AS gross_amount,
      COALESCE(d.platform_fee, 0) AS platform_fee,
      GREATEST(0, LEAST(
        d.amount,
        COALESCE(p.organizer_share, 0)
        - COALESCE(SUM(
            d.amount
          ) OVER (
            PARTITION BY d.payment_id
            ORDER BY d.created_at, d.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::INTEGER AS organizer_share,
      0::INTEGER AS money_in,
      GREATEST(0, LEAST(
        d.amount,
        COALESCE(p.organizer_share, 0)
        - COALESCE(SUM(
            d.amount
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
      NULL::TIMESTAMPTZ AS confirmed_at,
      NULL::TEXT AS resolution_notes,
      NULL::TIMESTAMPTZ AS resolved_at
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
      NULL::TIMESTAMPTZ AS confirmed_at,
      NULL::TEXT AS resolution_notes,
      NULL::TIMESTAMPTZ AS resolved_at
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

CREATE OR REPLACE FUNCTION public.get_organizer_financial_statement(p_community_id uuid, p_event_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT (public.is_community_owner(p_community_id) OR public.is_community_team(p_community_id) OR public.is_admin_user()) THEN
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
      COALESCE(d.payment_amount, p.amount, d.amount) AS gross_amount,
      COALESCE(d.platform_fee, 0) AS platform_fee,
      GREATEST(0, LEAST(
        d.amount,
        COALESCE(p.organizer_share, 0)
        - COALESCE(SUM(
            d.amount
          ) OVER (
            PARTITION BY d.payment_id
            ORDER BY d.created_at, d.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::INTEGER AS organizer_share,
      0::INTEGER AS money_in,
      GREATEST(0, LEAST(
        d.amount,
        COALESCE(p.organizer_share, 0)
        - COALESCE(SUM(
            d.amount
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
      NULL::TIMESTAMPTZ AS confirmed_at,
      NULL::TEXT AS resolution_notes,
      NULL::TIMESTAMPTZ AS resolved_at
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
      NULL::TIMESTAMPTZ AS confirmed_at,
      NULL::TEXT AS resolution_notes,
      NULL::TIMESTAMPTZ AS resolved_at
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
      'confirmed_at', t.confirmed_at,
      'resolution_notes', t.resolution_notes,
      'resolved_at', t.resolved_at
    )
    ORDER BY t.created_at DESC
  ), '[]'::JSONB)
  INTO v_result
  FROM raw_transactions t;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_record_manual_payout(p_community_id uuid, p_amount integer, p_utr text, p_payment_method text DEFAULT 'IMPS'::text, p_event_id uuid DEFAULT NULL::uuid, p_admin_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_community RECORD;
  v_event RECORD;
  v_beneficiary RECORD;
  v_payout_id UUID;
  v_normalized_utr TEXT;
  v_locked_payouts BIGINT := 0;
  v_uncommitted_balance BIGINT := 0;

  -- Event-level limits
  v_event_gross_organizer_share BIGINT := 0;
  v_event_refund_debits BIGINT := 0;
  v_event_settled_payouts BIGINT := 0;
  v_event_locked_payouts BIGINT := 0;
  v_event_available_payable BIGINT := 0;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can record manual payouts.';
  END IF;

  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payout amount must be greater than zero.');
  END IF;

  v_normalized_utr := UPPER(TRIM(COALESCE(p_utr, '')));
  IF v_normalized_utr = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UTR / Bank transaction reference is required.');
  END IF;

  -- Concurrency-safe duplicate active payout check
  IF EXISTS (
    SELECT 1 FROM public.payout_items
    WHERE community_id = p_community_id
      AND COALESCE(event_id, '00000000-0000-0000-0000-000000000000'::UUID) = COALESCE(p_event_id, '00000000-0000-0000-0000-000000000000'::UUID)
      AND UPPER(TRIM(utr)) = v_normalized_utr
      AND status IN ('pending_confirmation', 'success')
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'duplicate_payout_utr',
      'message', 'A payout with this UTR / Bank Reference is already recorded for this event or wallet and is currently active.'
    );
  END IF;

  -- GLOBAL LOCK HIERARCHY:
  -- Level 1: Lock community row FOR UPDATE
  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = p_community_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Community not found.');
  END IF;

  -- Level 2: Lock event row FOR UPDATE if event attribution is provided
  IF p_event_id IS NOT NULL THEN
    SELECT e.* INTO v_event
    FROM public.events e
    WHERE e.id = p_event_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Event not found.');
    END IF;

    IF v_event.community_id != p_community_id THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Event does not belong to the selected community.');
    END IF;

    -- Compute Event Gross Organizer Sales Earned.
    -- Sum wallet_credited audit entries rather than payments.organizer_share:
    -- a payment row is REUSED across cancel->rebook, so payments.organizer_share
    -- only holds the latest sale and under-counts the historical sale, while
    -- payment_refund_history still subtracts the earlier refund (netting to 0).
    SELECT COALESCE(SUM((pal.details->>'amount')::BIGINT), 0)
    INTO v_event_gross_organizer_share
    FROM public.payment_audit_log pal
    WHERE pal.action = 'wallet_credited'
      AND pal.details->>'event_id' IS NOT NULL
      AND (pal.details->>'event_id')::uuid = p_event_id;

    -- Compute Event Verified Customer Refund Debits
    WITH deduped_prh AS (
      SELECT DISTINCT ON (COALESCE(prh.razorpay_refund_id, prh.id::TEXT))
        prh.*
      FROM public.payment_refund_history prh
      WHERE prh.event_id = p_event_id
      ORDER BY COALESCE(prh.razorpay_refund_id, prh.id::TEXT), prh.created_at DESC
    ),
    calculated_refunds AS (
      SELECT
        d.id,
        GREATEST(0, LEAST(
          d.amount,
          COALESCE(p.organizer_share, 0)
          - COALESCE(SUM(
              d.amount
            ) OVER (
              PARTITION BY d.payment_id
              ORDER BY d.created_at, d.id
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ), 0)
        ))::BIGINT AS single_refund_debit
      FROM deduped_prh d
      LEFT JOIN public.payments p ON p.id = d.payment_id
      WHERE (
        p.status = 'refunded'
        OR EXISTS (
          SELECT 1 FROM public.payment_audit_log pal
          WHERE pal.action = 'wallet_debited'
            AND ((pal.details->>'event_id')::UUID = p_event_id OR pal.payment_id = d.payment_id)
        )
      )
    )
    SELECT COALESCE(SUM(single_refund_debit), 0)::BIGINT
    INTO v_event_refund_debits
    FROM calculated_refunds;

    -- Compute Event Settled Payouts
    SELECT COALESCE(SUM(amount), 0)::BIGINT
    INTO v_event_settled_payouts
    FROM public.payout_items
    WHERE event_id = p_event_id
      AND status = 'success';

    -- Compute Event In-Flight Locked Payouts (pending + disputed)
    SELECT COALESCE(SUM(amount), 0)::BIGINT
    INTO v_event_locked_payouts
    FROM public.payout_items
    WHERE event_id = p_event_id
      AND status IN ('pending_confirmation', 'disputed');

    -- Calculate Available Uncommitted Event Payable Balance
    v_event_available_payable := GREATEST(0, (v_event_gross_organizer_share - v_event_refund_debits - v_event_settled_payouts - v_event_locked_payouts));

    IF p_amount > v_event_available_payable THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'insufficient_event_payable_balance',
        'message', format('Requested payout amount (%s paise) exceeds available uncommitted event balance (%s paise). In-flight pending and disputed payouts for this event are reserved.', p_amount, v_event_available_payable),
        'event_available_payable', v_event_available_payable,
        'event_gross_earned', (v_event_gross_organizer_share - v_event_refund_debits),
        'event_settled_payouts', v_event_settled_payouts,
        'event_locked_payouts', v_event_locked_payouts
      );
    END IF;
  END IF;

  -- Community-level balance validation
  SELECT COALESCE(SUM(amount), 0) INTO v_locked_payouts
  FROM public.payout_items
  WHERE community_id = p_community_id
    AND status IN ('pending_confirmation', 'disputed');

  v_uncommitted_balance := GREATEST(0, v_community.wallet_balance - v_locked_payouts);

  IF p_amount > v_uncommitted_balance THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_uncommitted_balance',
      'message', format('Requested payout amount (%s paise) exceeds available uncommitted wallet balance (%s paise). In-flight pending and disputed payouts are reserved.', p_amount, v_uncommitted_balance),
      'uncommitted_balance', v_uncommitted_balance,
      'locked_payouts', v_locked_payouts,
      'stored_wallet_balance', v_community.wallet_balance
    );
  END IF;

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
    v_normalized_utr,
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
    'utr', v_normalized_utr,
    'admin_id', auth.uid(),
    'locked_payouts', v_locked_payouts + p_amount,
    'remaining_uncommitted', v_uncommitted_balance - p_amount
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'payout_id', v_payout_id,
    'amount', p_amount,
    'status', 'pending_confirmation',
    'uncommitted_balance', (v_uncommitted_balance - p_amount)
  );
END;
$function$;
