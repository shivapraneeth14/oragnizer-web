-- ============================================================================
-- Fix get_wallet_statement: honest running balance
-- 1. Include ALL payout statuses as debits (failed/pending payouts also had a
--    real wallet debit at initiation — previously only processing/success were
--    shown, so failed withdrawals appeared as pure refunds and the running
--    balance inflated).
-- 2. Anchor the running balance to the actual communities.wallet_balance so
--    the statement always reconciles to the wallet card, regardless of
--    historical gaps in the audit log.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_wallet_statement(p_community_id UUID)
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
      'Withdrawal → ' || COALESCE(cb.label, cb.account_holder, 'Bank account') AS description,
      NULL::UUID AS payment_id,
      pi.id AS payout_id
    FROM public.payout_items pi
    LEFT JOIN public.community_beneficiaries cb ON cb.id = pi.beneficiary_id
    WHERE pi.community_id = p_community_id

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
      'running_balance', w.running_balance
    )
    ORDER BY w.created_at ASC
  ) INTO v_result
  FROM with_balance w;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;
