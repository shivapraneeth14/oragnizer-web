-- Fix RLS recursion for admin policies by using security definer helper

CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true
  );
$$;

DROP POLICY IF EXISTS admin_read_all_profiles ON profiles;
DROP POLICY IF EXISTS admin_read_all_communities ON communities;
DROP POLICY IF EXISTS admin_read_all_events ON events;
DROP POLICY IF EXISTS admin_read_all_community_members ON community_members;
DROP POLICY IF EXISTS admin_read_all_join_requests ON join_requests;
DROP POLICY IF EXISTS admin_read_all_registrations ON registrations;
DROP POLICY IF EXISTS admin_read_all_payments ON payments;

CREATE POLICY admin_read_all_profiles ON profiles FOR SELECT USING (public.is_admin_user());
CREATE POLICY admin_read_all_communities ON communities FOR SELECT USING (public.is_admin_user());
CREATE POLICY admin_read_all_community_members ON community_members FOR SELECT USING (public.is_admin_user());
CREATE POLICY admin_read_all_events ON events FOR SELECT USING (public.is_admin_user());
CREATE POLICY admin_read_all_join_requests ON join_requests FOR SELECT USING (public.is_admin_user());
CREATE POLICY admin_read_all_registrations ON registrations FOR SELECT USING (public.is_admin_user());
CREATE POLICY admin_read_all_payments ON payments FOR SELECT USING (public.is_admin_user());
