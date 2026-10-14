-- ============================================================================
-- CLUVO — B1: stop authenticated users reading every profile's email/is_admin
--
-- Problem: profiles_public_basic_read is USING(true). Supabase's platform
-- grants table-wide SELECT on public tables to anon/authenticated, so the
-- earlier `REVOKE SELECT (email) ... FROM anon` (202610110001) is INEFFECTIVE
-- against a table-level grant: a table-wide privilege is stored as "all
-- columns" and cannot be narrowed by revoking an individual column while it is
-- held. Result: ANY authenticated member could enumerate every user's email
-- and is_admin via PostgREST.
--
-- Fix (declarative column projection):
--   1. Drop the table-wide SELECT from anon/authenticated.
--   2. Re-grant SELECT on ONLY the non-sensitive columns clients render.
--   email + is_admin are not re-granted, so PostgREST omits them for clients.
--
-- Authorized email/is_admin reads now go through the service-role edge
-- functions `admin-list-profiles` (platform admins) and `organizer-contacts`
-- (a community's owner/team), which check authorization server-side.
-- ============================================================================

-- 1. Remove the table-wide grant so column REVOKEs become effective.
--    PUBLIC is included because a privilege granted to PUBLIC applies to every
--    role, and would otherwise keep the table-wide access alive.
REVOKE SELECT ON public.profiles FROM anon, authenticated, PUBLIC;

-- 2. Re-grant only non-sensitive, client-rendered columns.
--    NOTE: email, is_admin are intentionally excluded.
GRANT SELECT (
  id,
  first_name,
  last_name,
  username,
  avatar_url,
  created_at,
  updated_at,
  deleted_at
) ON public.profiles TO anon, authenticated;

-- 3. Defence in depth: if a prior table-level grant left an explicit email
--    column grant behind on anon/authenticated/PUBLIC, remove it now that the
--    table-wide grant is gone (idempotent if it never existed).
REVOKE SELECT (email) ON public.profiles FROM anon, authenticated, PUBLIC;
REVOKE SELECT (is_admin) ON public.profiles FROM anon, authenticated, PUBLIC;

-- 4. service_role (all edge functions) must keep full profile access. Make it
--    explicit so this migration cannot strand it if it previously depended on
--    a PUBLIC/table-wide grant that step 1 removed.
GRANT SELECT ON public.profiles TO service_role;
