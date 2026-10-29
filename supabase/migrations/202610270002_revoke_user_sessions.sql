-- ============================================================================
-- CLUVO — Revoke a user's sessions server-side (E-04)
--
-- Problem
--   admin-delete-user tried `supabase.auth.admin.signOut(user_id, "global")`,
--   but that API takes the *user's JWT*, not a user id. The call always
--   failed, was swallowed by a try/catch, and wrote only a log line. A
--   suspended user therefore kept their existing access token and, until it
--   expired, could keep using the app — and with 202610270001 in place they
--   can no longer clear the marker themselves, but the live token still works.
--
-- Fix
--   A service-role-only RPC that deletes the user's refresh tokens and
--   sessions from the GoTrue schema. Existing access tokens remain valid
--   until they expire, so this pairs with a shorter JWT lifetime
--   (supabase/config.toml jwt_expiry = 900 for local/dev; the hosted project's
--   value is set in the Supabase dashboard / Management API).
--
--   The `auth` schema is not exposed through PostgREST, so an RPC is the only
--   way an edge function can do this without a direct Postgres connection.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_revoke_user_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_revoked integer := 0;
BEGIN
  -- SECURITY DEFINER: current_user is the function owner, so authorise on the
  -- request's JWT role (the service role key used by edge functions).
  IF coalesce(
       current_setting('request.jwt.claims', true)::jsonb ->> 'role',
       ''
     ) <> 'service_role' THEN
    RAISE EXCEPTION 'admin_revoke_user_sessions is service_role only'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = '22004';
  END IF;

  -- Refresh tokens carry user_id as text in GoTrue; sessions carry uuid.
  DELETE FROM auth.refresh_tokens WHERE user_id = p_user_id::text;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  DELETE FROM auth.sessions WHERE user_id = p_user_id;

  RETURN v_revoked;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_revoke_user_sessions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_user_sessions(uuid) TO service_role;

COMMENT ON FUNCTION public.admin_revoke_user_sessions(uuid) IS
  'Deletes a user''s GoTrue refresh tokens + sessions. Service role only.';
