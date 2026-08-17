-- ============================================================================
-- CLUVO - PASS 2: payout proof details (Cashfree-sourced)
-- 1. payout_items gains Cashfree's verbatim fields: utr, cashfree_status,
--    status_reason. UI now shows proof per withdrawal (details dialog).
-- 2. get_wallet_statement: payout rows carry status / cashfree_ref / utr /
--    reason / refunded / refunded_at so the dialog never invents a value —
--    everything displayed is exactly what Cashfree's webhook delivered.
-- ============================================================================

ALTER TABLE public.payout_items
  ADD COLUMN IF NOT EXISTS utr TEXT,
  ADD COLUMN IF NOT EXISTS cashfree_status TEXT,
  ADD COLUMN IF NOT EXISTS status_reason TEXT;

-- ---------------------------------------------------------------------------
-- get_wallet_statement: withdraw-with-proof fields on payout rows
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
      (al.details->>'event_id')::UUID AS event_id,
      NULL::TEXT AS status,
      NULL::TEXT AS cashfree_ref,
      NULL::TEXT AS cashfree_status,
      NULL::TEXT AS utr,
      NULL::TEXT AS reason,
      NULL::BOOLEAN AS refunded,
      NULL::TIMESTAMPTZ AS refunded_at
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
      (al.details->>'event_id')::UUID AS event_id,
      NULL::TEXT AS status,
      NULL::TEXT AS cashfree_ref,
      NULL::TEXT AS cashfree_status,
      NULL::TEXT AS utr,
      NULL::TEXT AS reason,
      NULL::BOOLEAN AS refunded,
      NULL::TIMESTAMPTZ AS refunded_at
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
      (al.details->>'event_id')::UUID AS event_id,
      NULL::TEXT AS status,
      NULL::TEXT AS cashfree_ref,
      NULL::TEXT AS cashfree_status,
      NULL::TEXT AS utr,
      NULL::TEXT AS reason,
      NULL::BOOLEAN AS refunded,
      NULL::TIMESTAMPTZ AS refunded_at
    FROM public.payment_audit_log al
    WHERE al.action IN ('payout_stuck_refunded', 'wallet_refunded')
      AND al.details->>'community_id' = p_community_id::TEXT
      AND (p_event_id IS NULL OR (al.details->>'event_id')::UUID = p_event_id)

    UNION ALL

    -- Payouts (never event-scoped; excluded when filtering by event).
    -- Every proof field below mirrors Cashfree's webhook payload verbatim.
    SELECT
      pi.created_at,
      'debit' AS ttype,
      -pi.amount AS net_amount,
      NULL::INTEGER AS credit_amount,
      pi.amount AS debit_amount,
      'Withdrawal → ' || COALESCE(cb.label, cb.account_holder, 'Bank account') AS description,
      NULL::UUID AS payment_id,
      pi.id AS payout_id,
      NULL::UUID AS event_id,
      pi.status AS status,
      pi.cashfree_payout_id AS cashfree_ref,
      pi.cashfree_status AS cashfree_status,
      pi.utr AS utr,
      COALESCE(pi.status_reason, pi.error_message) AS reason,
      EXISTS (
        SELECT 1
        FROM public.payment_audit_log al
        WHERE al.action IN ('wallet_refunded', 'payout_stuck_refunded')
          AND al.details->>'payout_id' = pi.id::TEXT
          AND al.details->>'community_id' = p_community_id::TEXT
      ) AS refunded,
      (
        SELECT al.created_at
        FROM public.payment_audit_log al
        WHERE al.action IN ('wallet_refunded', 'payout_stuck_refunded')
          AND al.details->>'payout_id' = pi.id::TEXT
          AND al.details->>'community_id' = p_community_id::TEXT
        ORDER BY al.created_at DESC
        LIMIT 1
      ) AS refunded_at
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
      'status', w.status,
      'cashfree_ref', w.cashfree_ref,
      'cashfree_status', w.cashfree_status,
      'utr', w.utr,
      'reason', w.reason,
      'refunded', w.refunded,
      'refunded_at', w.refunded_at,
      'running_balance', w.running_balance
    )
    ORDER BY w.created_at ASC
  ) INTO v_result
  FROM with_balance w;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

GRANT EXECUTE ON FUNCTION get_wallet_statement(UUID, UUID) TO authenticated;