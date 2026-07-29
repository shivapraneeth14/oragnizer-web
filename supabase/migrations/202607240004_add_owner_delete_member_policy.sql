CREATE POLICY "community_members_owner_delete" ON community_members
  FOR DELETE USING (is_community_owner(community_id));
