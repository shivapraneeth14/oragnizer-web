ALTER TABLE profiles ADD COLUMN is_admin boolean DEFAULT false;

CREATE POLICY admin_read_all_profiles ON profiles FOR SELECT USING (
  auth.uid() IN (SELECT id FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

CREATE POLICY admin_read_all_communities ON communities FOR SELECT USING (
  auth.uid() IN (SELECT id FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

CREATE POLICY admin_read_all_community_members ON community_members FOR SELECT USING (
  auth.uid() IN (SELECT id FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

CREATE POLICY admin_read_all_events ON events FOR SELECT USING (
  auth.uid() IN (SELECT id FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

CREATE POLICY admin_read_all_join_requests ON join_requests FOR SELECT USING (
  auth.uid() IN (SELECT id FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

CREATE POLICY admin_read_all_registrations ON registrations FOR SELECT USING (
  auth.uid() IN (SELECT id FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

CREATE POLICY admin_read_all_payments ON payments FOR SELECT USING (
  auth.uid() IN (SELECT id FROM profiles WHERE id = auth.uid() AND is_admin = true)
);
