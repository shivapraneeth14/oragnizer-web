-- ============================================================================
-- CLUVO STAGE 6 PHASE 3 — BUG-007: Owner Self-Delete Guard on community_members
--
-- Prevents a community owner from self-deleting their own membership row,
-- which would orphan the community's membership and leadership state.
-- Owners must either transfer ownership or close/delete the community.
-- ============================================================================

DROP POLICY IF EXISTS community_members_self_delete ON public.community_members;
CREATE POLICY community_members_self_delete ON public.community_members
  FOR DELETE USING (
    user_id = auth.uid()
    AND role != 'OWNER'
    AND NOT EXISTS (
      SELECT 1 FROM public.communities c
      WHERE c.id = community_members.community_id
        AND c.owner_id = auth.uid()
    )
  );

COMMENT ON POLICY community_members_self_delete ON public.community_members IS
  'Allows non-owner members to leave a community. Prevents community owners from orphaning their community.';

