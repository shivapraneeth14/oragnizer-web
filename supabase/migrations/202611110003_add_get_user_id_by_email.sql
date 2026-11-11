-- ============================================================================
-- CHIGZO — O(1) user lookup by email
--
-- findUserByEmail previously paginated auth.admin.listUsers (1,000 users per
-- request, up to 100 pages) on every forgot-password / verify-otp /
-- check-account call — a request-amplification vector.
--
-- auth.users.email is unique and indexed and Supabase Auth stores emails
-- lowercased, so a SECURITY DEFINER function can resolve the user id in one
-- indexed query. Service-role only; never exposed to clients.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_user_id_by_email(p_email TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT id FROM auth.users WHERE email = lower(p_email) LIMIT 1;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_user_id_by_email(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_id_by_email(TEXT) TO service_role;

COMMENT ON FUNCTION public.get_user_id_by_email(TEXT) IS
  'Service-role-only O(1) email -> auth user id lookup (replaces paginated listUsers scans).';
