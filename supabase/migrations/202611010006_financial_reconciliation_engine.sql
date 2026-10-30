-- ============================================================================
-- CLUVO STAGE 5 MILESTONE D — MIGRATION 202611010006
-- Financial Reconciliation and Observability Engine:
-- 1. Three-way Wallet Reconciliation:
--    Path 1: Stored Wallet Balance (communities.wallet_balance)
--    Path 2: Audit Ledger Balance (payment_audit_log credits - debits)
--    Path 3: Primary Transactions Balance (sales organizer share - verified refund debits - confirmed payouts)
-- 2. Scoped Discrepancy Scanners:
--    - Payment discrepancies (orphan payments, unconfirmed registrations, duplicate payment IDs, currency/amount split mismatches, stuck pending payments, legacy unpartitioned fees)
--    - Refund discrepancies (orphan refunds, refund exceeding payment amount, duplicate refund IDs, stuck pending refunds, failed queue tasks)
--    - Settlement discrepancies (pending payouts exceeding wallet balance, disputed payouts, duplicate active UTRs)
-- 3. Global Settlement Overview:
--    Gross revenue, platform fees, refunds, confirmed payouts, pending payouts, disputed payouts, uncommitted payable balance.
-- 4. Lightweight Observability KPIs function for admin dashboards.
-- 5. Concurrency-Safe Admin Manual Payout Recording with Uncommitted Balance Enforcement (SELECT ... FOR UPDATE).
--
-- STRICT CONSTRAINTS:
-- - Reconciliation functions are STABLE, strictly read-only: NEVER mutates payments, wallets, refunds, or payouts.
-- - Integer paise precision everywhere.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.run_financial_reconciliation(
  p_community_id UUID DEFAULT NULL,
  p_batch_limit INTEGER DEFAULT 1000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
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
      (COALESCE(cps.organizer_sales_earned, 0) - COALESCE(crt.total_organizer_refund_debits, 0) - COALESCE(cpt.confirmed_payouts, 0))::BIGINT AS primary_transaction_balance,
      COALESCE(cpt.pending_payouts, 0)::BIGINT AS in_flight_pending_payouts,
      COALESCE(cpt.disputed_payouts, 0)::BIGINT AS disputed_payouts,
      GREATEST(0, (tc.stored_wallet - COALESCE(cpt.pending_payouts, 0) - COALESCE(cpt.disputed_payouts, 0)))::BIGINT AS uncommitted_wallet_balance,
      COALESCE(cps.gross_sales, 0)::BIGINT AS gross_sales,
      COALESCE(cps.platform_fees_collected, 0)::BIGINT AS platform_fees,
      COALESCE(cps.organizer_sales_earned, 0)::BIGINT AS organizer_sales_earned,
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
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.run_financial_reconciliation(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_financial_reconciliation(UUID, INTEGER) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. Lightweight Financial Observability KPIs Function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_financial_observability_kpis()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  v_is_authorized BOOLEAN;
  v_stored_wallet BIGINT := 0;
  v_pending_payouts BIGINT := 0;
  v_disputed_payouts BIGINT := 0;
  v_disputed_count INTEGER := 0;
  v_total_communities INTEGER := 0;
  v_pending_queue_count INTEGER := 0;
  v_system_health TEXT := 'HEALTHY';
BEGIN
  -- Strict privilege check: Platform admin or service_role
  v_is_authorized := (
    public.is_admin_user()
    OR COALESCE((auth.jwt() ->> 'role'), '') = 'service_role'
    OR current_setting('request.jwt.claim.role', true) = 'service_role'
    OR current_user = 'service_role'
  );

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can view financial observability KPIs.';
  END IF;

  -- 1. Communities wallet balance
  SELECT
    COALESCE(SUM(wallet_balance), 0),
    COUNT(*)
  INTO v_stored_wallet, v_total_communities
  FROM public.communities;

  -- 2. Payout states
  SELECT
    COALESCE(SUM(CASE WHEN status = 'pending_confirmation' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status = 'disputed' THEN amount ELSE 0 END), 0),
    COUNT(*) FILTER (WHERE status = 'disputed')
  INTO v_pending_payouts, v_disputed_payouts, v_disputed_count
  FROM public.payout_items;

  -- 3. Incomplete cancellation / refund tasks
  SELECT COUNT(*)
  INTO v_pending_queue_count
  FROM public.refund_task_queue
  WHERE status IN ('failed', 'uncertain', 'manual_review');

  -- Health classification
  IF v_disputed_count > 0 OR v_pending_queue_count > 0 THEN
    v_system_health := 'WARNING';
  END IF;

  IF (v_pending_payouts + v_disputed_payouts) > v_stored_wallet THEN
    v_system_health := 'CRITICAL';
  END IF;

  RETURN jsonb_build_object(
    'system_health', v_system_health,
    'total_stored_wallet_paise', v_stored_wallet,
    'total_pending_payouts_paise', v_pending_payouts,
    'total_disputed_payouts_paise', v_disputed_payouts,
    'total_uncommitted_payable_paise', GREATEST(0, (v_stored_wallet - v_pending_payouts - v_disputed_payouts)),
    'disputed_payouts_count', v_disputed_count,
    'alert_queue_tasks_count', v_pending_queue_count,
    'total_communities_count', v_total_communities,
    'timestamp', clock_timestamp()
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_financial_observability_kpis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_financial_observability_kpis() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. Concurrency-Safe Admin Manual Payout Recording with Uncommitted Balance Enforcement
-- ----------------------------------------------------------------------------
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
  v_normalized_utr TEXT;
  v_locked_payouts BIGINT := 0;
  v_uncommitted_balance BIGINT := 0;
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

  -- 1. Concurrency-safe duplicate active payout check
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

  -- 2. Concurrency-safe row-level lock on community
  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = p_community_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Community not found.');
  END IF;

  -- 3. Calculate all currently locked payouts (pending_confirmation + disputed)
  SELECT COALESCE(SUM(amount), 0) INTO v_locked_payouts
  FROM public.payout_items
  WHERE community_id = p_community_id
    AND status IN ('pending_confirmation', 'disputed');

  -- 4. Calculate uncommitted wallet balance available for new payouts
  v_uncommitted_balance := GREATEST(0, v_community.wallet_balance - v_locked_payouts);

  -- 5. Enforce available payout limit
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

  -- Find active beneficiary
  SELECT cb.* INTO v_beneficiary
  FROM public.community_beneficiaries cb
  WHERE cb.community_id = p_community_id
    AND cb.is_active = true
  LIMIT 1;

  -- Record transfer in pending_confirmation state (wallet_balance is NOT deducted until organizer acknowledgement)
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

  -- Append to immutable payment audit log
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
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_record_manual_payout(UUID, INTEGER, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_record_manual_payout(UUID, INTEGER, TEXT, TEXT, UUID, TEXT) TO authenticated, service_role;
