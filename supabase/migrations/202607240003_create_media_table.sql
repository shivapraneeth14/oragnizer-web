CREATE TABLE media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mediable_id UUID NOT NULL,
  mediable_type TEXT NOT NULL CHECK (mediable_type IN ('community', 'event')),
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  type TEXT NOT NULL DEFAULT 'image' CHECK (type IN ('image', 'video')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  caption TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_media_mediable ON media(mediable_type, mediable_id, sort_order);

ALTER TABLE media ENABLE ROW LEVEL SECURITY;

CREATE POLICY "media_public_read" ON media FOR SELECT
  USING (
    (mediable_type = 'community' AND EXISTS (
      SELECT 1 FROM communities c WHERE c.id = mediable_id AND c.visibility = 'public' AND c.deleted_at IS NULL
    ))
    OR
    (mediable_type = 'event' AND EXISTS (
      SELECT 1 FROM events e JOIN communities c ON e.community_id = c.id
      WHERE e.id = mediable_id AND c.visibility = 'public' AND e.deleted_at IS NULL
    ))
  );

CREATE POLICY "media_owner_insert" ON media FOR INSERT WITH CHECK (
  (mediable_type = 'community' AND EXISTS (
    SELECT 1 FROM community_members WHERE community_id = mediable_id AND user_id = auth.uid() AND role = 'OWNER'
  ))
  OR
  (mediable_type = 'event' AND EXISTS (
    SELECT 1 FROM events WHERE id = mediable_id AND created_by = auth.uid()
  ))
);

CREATE POLICY "media_owner_delete" ON media FOR DELETE USING (
  (mediable_type = 'community' AND EXISTS (
    SELECT 1 FROM community_members WHERE community_id = mediable_id AND user_id = auth.uid() AND role = 'OWNER'
  ))
  OR
  (mediable_type = 'event' AND EXISTS (
    SELECT 1 FROM events WHERE id = mediable_id AND created_by = auth.uid()
  ))
);
