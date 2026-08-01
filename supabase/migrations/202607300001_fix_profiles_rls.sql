-- ============================================================================
-- CLUVO — Fix profiles RLS: revoke sensitive columns from public/authenticated
-- bank_account_number, bank_ifsc, pan, etc. were exposed via
-- profiles_public_basic_read (USING true). Column-level REVOKE prevents
-- reading them via client-side Supabase queries.
-- ============================================================================

-- Revoke sensitive PII / financial columns from both anon and authenticated
-- Users should never be able to read these columns for ANY profile via the
-- client SDK. Edge functions (using service_role key) bypass this restriction.
REVOKE SELECT(
  bank_account_holder,
  bank_ifsc,
  bank_account_number,
  pan,
  kyc_status,
  razorpay_contact_id,
  razorpay_fund_account_id
) ON profiles FROM anon, authenticated;

-- Drop and recreate the public read policy.
-- It still allows reading all rows, but the revoked columns are invisible
-- to client-side queries. Only non-sensitive columns (id, first_name,
-- last_name, username, avatar_url, email, etc.) are exposed.
DROP POLICY IF EXISTS profiles_public_basic_read ON profiles;

CREATE POLICY "profiles_public_basic_read" ON profiles
  FOR SELECT USING (true);
