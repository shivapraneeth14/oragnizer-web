-- ============================================================================
-- CLUVO — Fix communities RLS: revoke financial columns from anon
-- wallet_balance, cashfree_beneficiary_id, razorpay_account_id, etc. were
-- exposed to public users via communities_public_read.
-- Authenticated team members retain SELECT via communities_team_read.
-- ============================================================================

REVOKE SELECT(
  wallet_balance,
  cashfree_beneficiary_id,
  razorpay_account_id,
  razorpay_account_status,
  commission_percent
) ON communities FROM anon;
