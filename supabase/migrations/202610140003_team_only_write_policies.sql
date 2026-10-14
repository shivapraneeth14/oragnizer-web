-- ============================================================================
-- CLUVO — Restrict event/coupon writes and payout reads to actual team roles
--
-- Problem
--   is_community_member(community_id) is true for ANY row in community_members,
--   and community_members_self_insert lets any authenticated user self-join any
--   community as role 'MEMBER' (202607230013:3-4). These policies still use the
--   broad membership check, so any signed-in user can:
--     * insert/update events (title, price, capacity, status) in any community
--       (events_team_insert / events_team_update, 202607230012),
--     * mint or edit coupons for any community
--       (coupons_team_insert / coupons_team_update, 202607300008),
--     * read every payout (amount, beneficiary, UTR, failure reason) for any
--       community they follow (payout_team_read, 202607280002).
--
--   The team-read policies for communities/members/events/registrations/payments
--   were already hardened to is_community_team in 202610110002; these write/read
--   policies were missed.
--
-- Fix
--   Authorize via is_community_owner(...) OR is_community_team(...), which is
--   true only for OWNER / ORGANIZER / MODERATOR rows. Followers (MEMBER) lose
--   write/read of these team-only resources.
--
--   Removes an unauthorized capability only. Owners and true team members keep
--   full access; no legitimate organizer column is affected.
-- ============================================================================

-- events ---------------------------------------------------------------------
DROP POLICY IF EXISTS events_team_insert ON public.events;
CREATE POLICY events_team_insert ON public.events FOR INSERT WITH CHECK (
  public.is_community_owner(community_id) OR public.is_community_team(community_id)
);

DROP POLICY IF EXISTS events_team_update ON public.events;
CREATE POLICY events_team_update ON public.events FOR UPDATE USING (
  public.is_community_owner(community_id) OR public.is_community_team(community_id)
);

-- payout_items ---------------------------------------------------------------
DROP POLICY IF EXISTS "payout_team_read" ON public.payout_items;
CREATE POLICY "payout_team_read" ON public.payout_items FOR SELECT USING (
  public.is_community_owner(community_id) OR public.is_community_team(community_id)
);

-- coupons --------------------------------------------------------------------
DROP POLICY IF EXISTS "coupons_team_read" ON public.coupons;
CREATE POLICY "coupons_team_read" ON public.coupons FOR SELECT USING (
  public.is_community_owner(community_id) OR public.is_community_team(community_id)
);

DROP POLICY IF EXISTS "coupons_team_insert" ON public.coupons;
CREATE POLICY "coupons_team_insert" ON public.coupons FOR INSERT WITH CHECK (
  public.is_community_owner(community_id) OR public.is_community_team(community_id)
);

DROP POLICY IF EXISTS "coupons_team_update" ON public.coupons;
CREATE POLICY "coupons_team_update" ON public.coupons FOR UPDATE USING (
  public.is_community_owner(community_id) OR public.is_community_team(community_id)
);
