-- Add discussion settings to events
ALTER TABLE events
  ADD COLUMN discussion_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN discussion_restricted boolean NOT NULL DEFAULT false;

-- Create event_messages table
CREATE TABLE event_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_event_messages_event ON event_messages(event_id, created_at);

CREATE TRIGGER trg_event_messages_updated BEFORE UPDATE ON event_messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE event_messages ENABLE ROW LEVEL SECURITY;

-- Create event_restricted_users table for per-user posting bans
CREATE TABLE event_restricted_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(event_id, user_id)
);

ALTER TABLE event_restricted_users ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- RLS: event_messages
-- ============================================================================

-- SELECT: authenticated users, only for events with discussion enabled
CREATE POLICY "event_messages_select" ON event_messages FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM events e
      WHERE e.id = event_id AND e.discussion_enabled = true AND e.deleted_at IS NULL
    )
  );

-- INSERT: own messages, event enabled; if restricted must be admin; not banned
CREATE POLICY "event_messages_insert" ON event_messages FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM events e
      WHERE e.id = event_id AND e.discussion_enabled = true AND e.deleted_at IS NULL
      AND (
        e.discussion_restricted = false
        OR EXISTS (
          SELECT 1 FROM community_members cm
          WHERE cm.community_id = e.community_id AND cm.user_id = auth.uid()
          AND cm.role IN ('OWNER', 'ORGANIZER', 'MODERATOR')
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM event_restricted_users ru
      WHERE ru.event_id = event_messages.event_id AND ru.user_id = auth.uid()
    )
  );

-- UPDATE (edit): own messages OR admin of the community
CREATE POLICY "event_messages_update" ON event_messages FOR UPDATE
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM events e
      JOIN community_members cm ON cm.community_id = e.community_id
      WHERE e.id = event_id AND cm.user_id = auth.uid()
      AND cm.role IN ('OWNER', 'ORGANIZER', 'MODERATOR')
    )
  );

-- DELETE: own messages
CREATE POLICY "event_messages_delete_own" ON event_messages FOR DELETE
  USING (auth.uid() = user_id);

-- DELETE: admins can delete any message
CREATE POLICY "event_messages_delete_admin" ON event_messages FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM events e
    JOIN community_members cm ON cm.community_id = e.community_id
    WHERE e.id = event_id AND cm.user_id = auth.uid()
    AND cm.role IN ('OWNER', 'ORGANIZER', 'MODERATOR')
  ));

-- ============================================================================
-- RLS: event_restricted_users
-- ============================================================================

-- SELECT: users can see their own restrictions; admins can see all
CREATE POLICY "event_restricted_users_select_own" ON event_restricted_users FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "event_restricted_users_select_admin" ON event_restricted_users FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM events e
    JOIN community_members cm ON cm.community_id = e.community_id
    WHERE e.id = event_id AND cm.user_id = auth.uid()
    AND cm.role IN ('OWNER', 'ORGANIZER', 'MODERATOR')
  ));

-- INSERT: admins can restrict users
CREATE POLICY "event_restricted_users_insert" ON event_restricted_users FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM events e
    JOIN community_members cm ON cm.community_id = e.community_id
    WHERE e.id = event_id AND cm.user_id = auth.uid()
    AND cm.role IN ('OWNER', 'ORGANIZER', 'MODERATOR')
  ));

-- DELETE: admins can unrestrict users
CREATE POLICY "event_restricted_users_delete" ON event_restricted_users FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM events e
    JOIN community_members cm ON cm.community_id = e.community_id
    WHERE e.id = event_id AND cm.user_id = auth.uid()
    AND cm.role IN ('OWNER', 'ORGANIZER', 'MODERATOR')
  ));

-- Enable realtime for event_messages
ALTER PUBLICATION supabase_realtime ADD TABLE event_messages;
