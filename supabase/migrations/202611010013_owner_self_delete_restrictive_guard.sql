-- ============================================================================
-- CLUVO STAGE 6 PHASE 3 — BUG-007: Restrictive Owner Self-Delete Guard
--
-- Defense-in-depth:
-- 1. Updates permissive "community_members_owner_delete" so community owners
--    cannot use their owner delete privilege to delete their own membership row.
-- 2. Adds AS RESTRICTIVE policy "block_owner_membership_delete" ensuring that
--    regardless of any permissive policy, an owner can NEVER self-delete their
--    membership row and orphan the community.
-- ============================================================================

-- 1. Tighten permissive owner member deletion policy
DROP POLICY IF EXISTS "community_members_owner_delete" ON public.community_members;
CREATE POLICY "community_members_owner_delete" ON public.community_members
  FOR DELETE
  TO authenticated
  USING (
    public.is_community_owner(community_id)
    AND user_id != auth.uid()
    AND role != 'OWNER'
  );

COMMENT ON POLICY "community_members_owner_delete" ON public.community_members IS
  'Allows community owners to remove other team members and regular members, but strictly forbids deleting the owner.';

-- 2. Restrictive policy enforcing zero owner self-deletion across all paths
DROP POLICY IF EXISTS "block_owner_membership_delete" ON public.community_members;
CREATE POLICY "block_owner_membership_delete" ON public.community_members
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (
    -- If the target row belongs to the caller, they cannot be an OWNER
    -- and cannot be the registered owner_id of the community.
    NOT (
      user_id = auth.uid()
      AND (
        role = 'OWNER'
        OR EXISTS (
          SELECT 1 FROM public.communities c
          WHERE c.id = community_members.community_id
            AND c.owner_id = auth.uid()
        )
      )
    )
  );

COMMENT ON POLICY "block_owner_membership_delete" ON public.community_members IS
  'Restrictive guard: unconditionally blocks community owners from deleting their own membership row.';
