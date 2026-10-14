-- ============================================================================
-- CLUVO — Guard privileged columns against direct client writes
--
-- Problem
--   1. profiles_self_update (202607220001) allows UPDATE of the caller's own
--      row with no column restriction. The earlier `REVOKE UPDATE (is_admin)`
--      (202610110001) is INEFFECTIVE against Supabase's table-wide UPDATE
--      grant to `authenticated` (a held table-level privilege cannot be
--      narrowed by a column revoke — same reasoning that 202610120005 used to
--      fix SELECT). Any authenticated user could set is_admin = true on their
--      own profile and satisfy every admin gate.
--   2. communities_owner_write (202607220001) allows an owner to UPDATE any
--      column of their community, including wallet_balance, platform_fee_amount
--      and the commission settings — direct wallet inflation / fee evasion.
--
-- Fix
--   BEFORE UPDATE guard triggers that reject changes to privileged columns
--   made by a real client role (anon/authenticated). The guard runs as the
--   invoker, so internal SECURITY DEFINER routines (which run as the function
--   owner) and service-role edge functions are unaffected — this keeps the
--   member_count maintenance trigger (update_community_member_count, a
--   SECURITY DEFINER trigger) and all wallet/refund/payout RPCs working.
--
--   This removes an unauthorized capability only; no legitimate client column
--   is restricted (clients edit name/location/description/avatar/socials via
--   the update-community-profile edge function, and first_name/last_name/
--   username/avatar_url on their own profile directly).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles: only the owner of the row is guarded; is_admin is privileged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profiles_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- internal routines (definer) and service_role run as a non-client role
  IF current_user IN ('anon', 'authenticated') THEN
    IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
      RAISE EXCEPTION 'is_admin cannot be changed from a client'
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

-- ---------------------------------------------------------------------------
-- 2. communities: wallet, fee/commission, counters, ownership, verification
--    and moderation flags are privileged. Clients must never write them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_communities_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
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

DROP TRIGGER IF EXISTS trg_communities_guard_privileged ON public.communities;
CREATE TRIGGER trg_communities_guard_privileged
  BEFORE UPDATE ON public.communities
  FOR EACH ROW EXECUTE FUNCTION public.guard_communities_privileged_columns();
