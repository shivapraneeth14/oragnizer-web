-- ============================================================================
-- CLUVO — Stop leaking community financial columns to every signed-in user
--
-- Problem
--   202610220010_authz_hardening.sql revoked the sensitive columns from
--   `anon`/PUBLIC, then explicitly re-granted table-wide SELECT to
--   `authenticated` (line 105) so organizer-web/admin-web could keep using
--   select("*"). But `authenticated` is the role every normal user holds, and
--   communities_public_read exposes every public, non-hidden community row.
--   Net: any logged-in user could read wallet_balance,
--   cashfree_beneficiary_id, razorpay_account_id/status and
--   platform_fee_amount for every public community.
--
-- Fix
--   1. Replace the table-wide grant with an explicit column whitelist.
--      contact_email/contact_phone stay readable (rendered on the community
--      profile) and commission_percent/commission_on stay readable (the
--      mobile price breakdown uses them).
--   2. Financial fields move behind get_community_financials(), a
--      SECURITY DEFINER RPC gated to owner / team / admin.
--
--   Keep the whitelist byte-for-byte in sync with COMMUNITY_CLIENT_COLUMNS in
--   packages/shared/src/constants.ts — supabase/tests/community_financials
--   .test.ts fails on drift.
-- ============================================================================

-- 1. Remove table-wide SELECT (and the PUBLIC inheritance path) first.
REVOKE SELECT ON public.communities FROM authenticated, PUBLIC;

-- 2. Grant back only non-financial columns.
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
  commission_on
) ON public.communities TO authenticated;

-- 3. Owner/team/admin-only read path for the withheld columns.
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
    c.razorpay_account_id,
    c.razorpay_account_status,
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

-- service_role keeps full table access for edge functions.
GRANT SELECT ON public.communities TO service_role;
