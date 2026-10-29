-- ============================================================================
-- CLUVO — Extend the profiles privileged-column guard to account state
--
-- Problem
--   202610140002 added guard_profiles_privileged_columns() to stop clients
--   from setting is_admin. It only compares is_admin, so profiles_self_update
--   (202607220001) still lets the row owner write every other column:
--
--     UPDATE profiles SET deleted_at = NULL                -- un-suspend self
--     UPDATE profiles SET deletion_grace_started_at = NULL -- cancel admin deletion
--     UPDATE profiles SET deletion_purging_at = NULL       -- interfere with purge
--     UPDATE profiles SET email = 'someone@else'           -- desync from auth.users
--
--   Column-level REVOKE cannot fix this: Supabase grants table-wide UPDATE to
--   `authenticated`, and a table-level privilege cannot be narrowed by a
--   column revoke (same trap documented in 202610140002).
--
-- Fix
--   Extend the existing BEFORE UPDATE trigger to reject changes to the
--   account-state columns from a real client role (anon/authenticated).
--   Every legitimate writer of these columns runs as service_role:
--     delete-account, admin-delete-user, admin-undelete-user,
--     purge-deleted-accounts, register/handle_new_user,
--     complete-google-profile, cancel-account-deletion.
--   The trigger runs as the invoker, so those paths are unaffected.
--
--   Client-writable columns are unchanged: first_name, last_name, username,
--   full_name, avatar_url.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_profiles_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- internal routines (definer) and service_role run as a non-client role
  IF current_user IN ('anon', 'authenticated') THEN
    IF NEW.is_admin                  IS DISTINCT FROM OLD.is_admin
       OR NEW.email                  IS DISTINCT FROM OLD.email
       OR NEW.deleted_at             IS DISTINCT FROM OLD.deleted_at
       OR NEW.deletion_grace_started_at IS DISTINCT FROM OLD.deletion_grace_started_at
       OR NEW.deletion_purging_at    IS DISTINCT FROM OLD.deletion_purging_at
    THEN
      RAISE EXCEPTION 'This profile field cannot be changed from a client'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_profiles_privileged_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_profiles_guard_privileged ON public.profiles;
CREATE TRIGGER trg_profiles_guard_privileged
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profiles_privileged_columns();
