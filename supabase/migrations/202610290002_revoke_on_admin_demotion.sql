-- ============================================================================
-- CLUVO — Automatic session revocation on admin demotion (F-07)
--
-- Problem:
--   When an administrator is demoted (profiles.is_admin changes from true
--   to false), existing JWTs and GoTrue refresh tokens remain active until
--   expiry, leaving a window where a demoted admin retains access.
--
-- Fix:
--   A SECURITY DEFINER trigger on public.profiles that immediately purges
--   auth.refresh_tokens and auth.sessions for that user whenever
--   is_admin changes from true to false.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_revoke_demoted_admin_sessions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.is_admin = true AND NEW.is_admin = false THEN
    -- Refresh tokens carry user_id as text in GoTrue; sessions carry uuid.
    DELETE FROM auth.refresh_tokens WHERE user_id = OLD.id::text;
    DELETE FROM auth.sessions WHERE user_id = OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trg_revoke_demoted_admin_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_revoke_demoted_admin_sessions() TO service_role;

DROP TRIGGER IF EXISTS trg_demote_admin_revoke_sessions ON public.profiles;
CREATE TRIGGER trg_demote_admin_revoke_sessions
AFTER UPDATE OF is_admin ON public.profiles
FOR EACH ROW
WHEN (OLD.is_admin = true AND NEW.is_admin = false)
EXECUTE FUNCTION public.trg_revoke_demoted_admin_sessions();

COMMENT ON FUNCTION public.trg_revoke_demoted_admin_sessions() IS
  'Purges GoTrue refresh tokens and sessions when an admin user is demoted.';
