-- ============================================================================
-- CLUVO — Deploy get_community_financials RPC
--
-- Forward migration to ensure get_community_financials RPC and column grants
-- are deployed to remote databases where 202610270003 was skipped due to
-- timestamp ordering.
-- ============================================================================

-- 1. Remove table-wide SELECT (and the PUBLIC inheritance path)
REVOKE SELECT ON public.communities FROM authenticated, PUBLIC;

-- 2. Grant back only non-financial columns
GRANT SELECT (
  id,
  name,
  description,
  location,
  banner_url,
  community_avatar_url,
  category,
  city,
  state,
  country,
  tags,
  rules,
  visibility,
  instagram_url,
  facebook_url,
  twitter_url,
  linkedin_url,
  owner_id,
  member_count,
  event_count,
  deleted_at,
  is_hidden,
  verification_status,
  created_at,
  updated_at,
  contact_email,
  contact_phone,
  commission_percent,
  commission_on,
  deletion_grace_started_at,
  is_hidden_before_deletion,
  closed_at
) ON public.communities TO authenticated;

-- 3. Owner/team/admin-only read path for the withheld columns
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
    AND (
      public.is_community_owner(c.id)
      OR public.is_community_team(c.id)
      OR public.is_admin_user()
    );
$$;

REVOKE ALL ON FUNCTION public.get_community_financials(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_community_financials(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_community_financials(uuid) IS
  'Returns withheld financial columns for one community. Owner/team/admin only; returns no rows otherwise.';

-- service_role keeps full table access for edge functions
GRANT SELECT ON public.communities TO service_role;
