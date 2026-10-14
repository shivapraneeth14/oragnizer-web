-- ============================================================================
-- CLUVO — Restrict community "team" reads to actual team roles
-- ============================================================================
--
-- Problem (scan finding C3)
--   is_community_member(community_id) is true for ANY row in community_members,
--   regardless of role. The "team read" policies (communities, community_members,
--   events, registrations, payments) grant SELECT for owner OR
--   is_community_member(...). Because the mobile "Join/Follow" button inserts a
--   row with role = 'MEMBER' (community_detail_screen.dart), any signed-in user
--   can follow any community and then read that community's registrations
--   (attendee PII + qr_code) and payments through the REST API.
--
-- Fix
--   Introduce is_community_team(community_id): true only for OWNER, ORGANIZER or
--   MODERATOR rows. Recreate the team-read policies to use owner OR team, so
--   followers (MEMBER) no longer see registrations/payments/member lists. Public
--   community/event reads and self-reads of one's own registration are unaffected.
--
--   This matches how the rest of the schema already gates team-only features
--   (event discussion, wallet attribution: cm.role IN ('OWNER','ORGANIZER','MODERATOR')).
--   Owners remain covered by the existing is_community_owner(...) branch.

CREATE OR REPLACE FUNCTION public.is_community_team(p_community_id UUID)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.community_members cm
    WHERE cm.community_id = p_community_id
      AND cm.user_id = auth.uid()
      AND cm.role IN ('OWNER', 'ORGANIZER', 'MODERATOR')
  );
$$;

-- communities
DROP POLICY IF EXISTS "communities_team_read" ON public.communities;
CREATE POLICY "communities_team_read" ON public.communities
  FOR SELECT USING (
    public.is_community_owner(id)
    OR public.is_community_team(id)
  );

-- community_members
DROP POLICY IF EXISTS "community_members_team_read" ON public.community_members;
CREATE POLICY "community_members_team_read" ON public.community_members
  FOR SELECT USING (
    public.is_community_owner(community_id)
    OR public.is_community_team(community_id)
  );

-- events
DROP POLICY IF EXISTS "events_team_read" ON public.events;
CREATE POLICY "events_team_read" ON public.events
  FOR SELECT USING (
    public.is_community_owner(community_id)
    OR public.is_community_team(community_id)
  );

-- registrations
DROP POLICY IF EXISTS "registrations_team_read" ON public.registrations;
CREATE POLICY "registrations_team_read" ON public.registrations
  FOR SELECT USING (
    public.is_community_owner((SELECT community_id FROM public.events WHERE id = event_id))
    OR public.is_community_team((SELECT community_id FROM public.events WHERE id = event_id))
  );

-- payments
DROP POLICY IF EXISTS "payments_team_read" ON public.payments;
CREATE POLICY "payments_team_read" ON public.payments
  FOR SELECT USING (
    public.is_community_owner((SELECT e.community_id FROM public.registrations r JOIN public.events e ON e.id = r.event_id WHERE r.id = registration_id))
    OR public.is_community_team((SELECT e.community_id FROM public.registrations r JOIN public.events e ON e.id = r.event_id WHERE r.id = registration_id))
  );
