-- ============================================================================
-- CLUVO — Wire is_hidden into RLS: hiding a community in admin-web must hide
-- its events (and related data: media, discussions, reviews) from everyone
-- except the community owner/team and platform admins.
-- Owner/team paths (communities_team_read, events_team_read, admin_read_all_*)
-- are intentionally left untouched so organizer-web and admin-web still work.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper: SECURITY DEFINER so policies can check communities.is_hidden without
-- hitting communities RLS (a plain subquery inside a policy is itself filtered
-- by RLS, which inverts NOT IN / NOT EXISTS checks — same class of bug fixed
-- for is_registered_for_event in 202608010003).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_community_hidden(community_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS
$$ SELECT EXISTS (
     SELECT 1 FROM public.communities
     WHERE id = $1 AND is_hidden
   ) $$;

REVOKE ALL ON FUNCTION public.is_community_hidden(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_community_hidden(uuid) TO anon, authenticated;

-- 1. Communities: public read excludes hidden communities
DROP POLICY IF EXISTS "communities_public_read" ON communities;
CREATE POLICY "communities_public_read" ON communities
  FOR SELECT USING (
    status = 'active' AND visibility = 'public' AND deleted_at IS NULL
    AND is_hidden = false
  );

-- 2. Events: public read excludes events of hidden communities
DROP POLICY IF EXISTS "events_public_read" ON events;
CREATE POLICY "events_public_read" ON events
  FOR SELECT USING (
    status = 'published' AND deleted_at IS NULL
    AND NOT public.is_community_hidden(community_id)
  );

-- 3. Registered users: also cannot see events of hidden communities
--    (their own-registration read access must not bypass the hide)
DROP POLICY IF EXISTS "events_registered_read" ON events;
CREATE POLICY "events_registered_read" ON events
  FOR SELECT USING (
    public.is_registered_for_event(id)
    AND NOT public.is_community_hidden(community_id)
  );

-- 4. Media: public read excludes media of hidden communities/events
DROP POLICY IF EXISTS "media_public_read" ON media;
CREATE POLICY "media_public_read" ON media
  FOR SELECT USING (
    (mediable_type = 'community' AND EXISTS (
      SELECT 1 FROM communities c
      WHERE c.id = mediable_id AND c.visibility = 'public'
        AND c.deleted_at IS NULL AND NOT c.is_hidden
    ))
    OR
    (mediable_type = 'event' AND EXISTS (
      SELECT 1 FROM events e JOIN communities c ON e.community_id = c.id
      WHERE e.id = mediable_id AND c.visibility = 'public'
        AND e.deleted_at IS NULL AND NOT c.is_hidden
    ))
  );

-- Media: owner/team can still read media of their own hidden communities
-- (organizer-web media management must keep working when a community is hidden)
CREATE POLICY "media_team_read" ON media FOR SELECT USING (
  (mediable_type = 'community' AND EXISTS (
    SELECT 1 FROM community_members
    WHERE community_id = mediable_id AND user_id = auth.uid()
  ))
  OR
  (mediable_type = 'event' AND EXISTS (
    SELECT 1 FROM events e JOIN community_members cm ON cm.community_id = e.community_id
    WHERE e.id = mediable_id AND cm.user_id = auth.uid()
  ))
);

-- 5. Event discussions: not readable when the community is hidden
DROP POLICY IF EXISTS "event_messages_select" ON event_messages;
CREATE POLICY "event_messages_select" ON event_messages
  FOR SELECT USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM events e JOIN communities c ON e.community_id = c.id
      WHERE e.id = event_id AND e.discussion_enabled = true
        AND e.deleted_at IS NULL AND NOT c.is_hidden
    )
  );

-- Event discussions: community admins can still read them for hidden communities
CREATE POLICY "event_messages_team_select" ON event_messages FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM events e
    JOIN community_members cm ON cm.community_id = e.community_id
    WHERE e.id = event_id AND cm.user_id = auth.uid()
      AND cm.role IN ('OWNER', 'ORGANIZER', 'MODERATOR')
  ));

-- 6. Reviews: not readable when the community is hidden
DROP POLICY IF EXISTS "reviews_public_read" ON reviews;
CREATE POLICY "reviews_public_read" ON reviews
  FOR SELECT USING (
    deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM events e JOIN communities c ON e.community_id = c.id
      WHERE e.id = event_id AND NOT c.is_hidden
    )
  );
