DROP FUNCTION IF EXISTS get_wallet_statement(UUID);

CREATE OR REPLACE FUNCTION get_wallet_statement(p_community_id UUID)
RETURNS TABLE(
  created_at TIMESTAMPTZ,
  description TEXT,
  credit_amount INTEGER,
  debit_amount INTEGER,
  running_balance BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_initial_balance BIGINT;
BEGIN
  WITH tracked AS (
    SELECT COALESCE(SUM(amount), 0) AS total_credits
    FROM public.payment_transfers
    WHERE community_id = p_community_id AND status = 'processed'
  ),
  tracked_debits AS (
    SELECT COALESCE(SUM(amount), 0) AS total_debits
    FROM public.payout_items
    WHERE community_id = p_community_id
  )
  SELECT c.wallet_balance - t.total_credits + td.total_debits
  INTO v_initial_balance
  FROM public.communities c
  CROSS JOIN tracked t
  CROSS JOIN tracked_debits td
  WHERE c.id = p_community_id;

  RETURN QUERY
  WITH all_entries AS (
    SELECT
      pt.created_at,
      'Payment received'::TEXT AS description,
      pt.amount AS credit_amount,
      NULL::INTEGER AS debit_amount,
      1 AS sort_order
    FROM public.payment_transfers pt
    WHERE pt.community_id = p_community_id AND pt.status = 'processed'

    UNION ALL

    SELECT
      pi.created_at,
      CASE WHEN pi.status = 'failed' THEN 'Withdrawal refunded' ELSE 'Withdrawal' END::TEXT,
      NULL::INTEGER,
      pi.amount,
      2 AS sort_order
    FROM public.payout_items pi
    WHERE pi.community_id = p_community_id
  )
  SELECT
    ae.created_at,
    ae.description,
    ae.credit_amount,
    ae.debit_amount,
    v_initial_balance + SUM(COALESCE(ae.credit_amount, 0) - COALESCE(ae.debit_amount, 0)) OVER (ORDER BY ae.created_at, ae.sort_order, ae.credit_amount NULLS LAST) AS running_balance
  FROM all_entries ae
  ORDER BY ae.created_at DESC, ae.sort_order DESC, ae.credit_amount NULLS FIRST;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_communities_name_unique
  ON public.communities (name)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_unique
  ON public.profiles (username)
  WHERE deleted_at IS NULL;
