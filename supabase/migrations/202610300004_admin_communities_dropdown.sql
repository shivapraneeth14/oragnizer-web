-- ============================================================================
-- CLUVO — Admin Communities Dropdown & Financial Balance RPC
--
-- Problem:
--   202610270003 and 202610290005 revoked table-wide SELECT on public.communities
--   from authenticated/PUBLIC to prevent non-admins from reading wallet_balance
--   and cashfree_beneficiary_id, granting back only non-financial columns.
--   When the admin console queries `select("id, name, owner_id, wallet_balance")`,
--   PostgreSQL denies access to the withheld column `wallet_balance`.
--
-- Solution:
--   Provide a dedicated SECURITY DEFINER RPC `get_admin_communities()` that
--   strictly validates `public.is_admin_user()` and returns all communities with
--   their name, owner_id, wallet_balance, deleted_at, and is_hidden status.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_admin_communities()
RETURNS TABLE (
  id UUID,
  name TEXT,
  owner_id UUID,
  wallet_balance INTEGER,
  deleted_at TIMESTAMPTZ,
  is_hidden BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    c.id,
    c.name,
    c.owner_id,
    c.wallet_balance,
    c.deleted_at,
    c.is_hidden
  FROM public.communities c
  WHERE public.is_admin_user()
  ORDER BY c.name ASC;
$$;

REVOKE ALL ON FUNCTION public.get_admin_communities() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_communities() TO authenticated, service_role;

COMMENT ON FUNCTION public.get_admin_communities() IS
  'Admin-only directory of all platform communities with their wallet balances and visibility status.';
