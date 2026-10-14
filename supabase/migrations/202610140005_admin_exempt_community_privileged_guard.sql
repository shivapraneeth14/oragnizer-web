-- ============================================================================
-- CLUVO — Allow admins to write privileged community columns
--
-- Problem
--   202610140002 added trg_communities_guard_privileged, which rejects any
--   change to privileged community columns made while current_user is
--   'anon'/'authenticated'. That correctly blocks a community owner from
--   inflating wallet_balance / fees or unhiding their own community, but it
--   also blocks the legitimate admin-web portal: CommunityDetailPage toggles
--   `is_hidden` with a direct client PATCH as role `authenticated`, which the
--   trigger rejects with ERRCODE 42501 -> PostgREST 403 Forbidden.
--
--   RLS already authorizes admins for this write
--   (admin_update_communities ON communities FOR UPDATE USING
--   public.is_admin_user(), 202607230010). The guard must not be stricter
--   than RLS for admins; it exists to constrain non-admin clients.
--
-- Fix
--   Re-create the guard so it only enforces the column restrictions for
--   non-admin client roles (anon/authenticated where is_admin_user() is
--   false). service_role and SECURITY DEFINER routines were already exempt
--   (they run as a non-client role); `public.is_admin_user()` cannot be forged
--   by non-admins because profiles.is_admin is itself guarded by
--   202610140002 and the table-wide client UPDATE cannot set it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_communities_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Client roles only, and never for admins (admins are RLS-authorized).
  IF current_user IN ('anon', 'authenticated')
     AND NOT public.is_admin_user()
  THEN
    IF NEW.wallet_balance        IS DISTINCT FROM OLD.wallet_balance
       OR NEW.cashfree_beneficiary_id IS DISTINCT FROM OLD.cashfree_beneficiary_id
       OR NEW.platform_fee_amount IS DISTINCT FROM OLD.platform_fee_amount
       OR NEW.commission_percent  IS DISTINCT FROM OLD.commission_percent
       OR NEW.commission_on       IS DISTINCT FROM OLD.commission_on
       OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
       OR NEW.owner_id            IS DISTINCT FROM OLD.owner_id
       OR NEW.member_count        IS DISTINCT FROM OLD.member_count
       OR NEW.event_count         IS DISTINCT FROM OLD.event_count
       OR NEW.is_hidden           IS DISTINCT FROM OLD.is_hidden
    THEN
      RAISE EXCEPTION 'This community field cannot be changed from a client'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_communities_privileged_columns() FROM PUBLIC, anon, authenticated;

-- Trigger already exists from 202610140002 and points at this function;
-- re-create to be idempotent.
DROP TRIGGER IF EXISTS trg_communities_guard_privileged ON public.communities;
CREATE TRIGGER trg_communities_guard_privileged
  BEFORE UPDATE ON public.communities
  FOR EACH ROW EXECUTE FUNCTION public.guard_communities_privileged_columns();
