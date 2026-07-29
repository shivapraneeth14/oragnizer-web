CREATE POLICY "communities_public_read" ON communities
  FOR SELECT USING (visibility = 'public' AND deleted_at IS NULL);
