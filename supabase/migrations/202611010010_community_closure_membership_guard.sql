-- ============================================================================
-- CLUVO STAGE 6 PHASE 2 — BUG-004: Community Closure Membership Guard
--
-- 1. Helper function public.is_community_accepting_members(p_community_id)
--    Checks that community is not deleted, closed, or in deletion grace.
--    SECURITY DEFINER and STABLE, qualified with SET search_path = ''.
--
-- 2. Permissive Policy community_members_self_insert:
--    Ensures regular users can only self-join active communities as MEMBER.
--    Preserves administrative recovery via public.is_admin_user().
--
-- 3. Restrictive Policy block_closure_community_members_insert:
--    Guarantees non-admin, non-service_role callers cannot insert into
--    communities undergoing closure grace (public.is_community_in_closure_grace).
-- ============================================================================

-- 1. Helper: check if community is accepting new members
CREATE OR REPLACE FUNCTION public.is_community_accepting_members(p_community_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.communities c
    WHERE c.id = p_community_id
      AND c.deleted_at IS NULL
      AND c.closed_at IS NULL
      AND c.deletion_grace_started_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION public.is_community_accepting_members(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_community_accepting_members(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.is_community_accepting_members(uuid) IS
  'Returns true only if the community exists, is not soft-deleted, not closed, and not in deletion grace.';

-- 2. Permissive self-join policy with admin recovery preservation
DROP POLICY IF EXISTS community_members_self_insert ON public.community_members;
CREATE POLICY community_members_self_insert ON public.community_members
  FOR INSERT WITH CHECK (
    (
      user_id = auth.uid() 
      AND role = 'MEMBER'
      AND public.is_community_accepting_members(community_id)
    )
    OR COALESCE(public.is_admin_user(), false)
  );

-- 3. Restrictive policy blocking insertions during community closure grace
DROP POLICY IF EXISTS "block_closure_community_members_insert" ON public.community_members;
CREATE POLICY "block_closure_community_members_insert" ON public.community_members
AS RESTRICTIVE
FOR INSERT
WITH CHECK (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    WHEN public.is_community_in_closure_grace(community_id) THEN false
    ELSE true
  END
);

