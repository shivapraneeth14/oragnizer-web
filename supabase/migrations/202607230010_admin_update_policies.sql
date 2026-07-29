CREATE POLICY admin_update_communities ON communities FOR UPDATE USING (public.is_admin_user());
CREATE POLICY admin_update_profiles ON profiles FOR UPDATE USING (public.is_admin_user());
