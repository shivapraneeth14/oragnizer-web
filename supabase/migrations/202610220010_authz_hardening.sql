-- ============================================================================
-- CLUVO — Authz hardening + PII retention fixes (audit findings F-2..F-8)
--
-- Covers:
--   F-2 (HIGH)  communities column projection — wallet_balance,
--               cashfree_beneficiary_id, contact_email/phone readable by anon
--   F-3         waitlist_team_read / waitlist_team_delete role-agnostic
--   F-4         media_team_read role-agnostic
--   F-6         reviews_public_read missing visibility='public'
--   F-8         is_community_member + update_community_member_count
--               missing SET search_path
--   D11         communities.deleted_at added to privileged-column guard
--   D12         legacy reports table dropped
--   D9          rate_limits: purge old rows, add TTL index
-- ============================================================================

-- ============================================================================
-- F-2: communities column projection
--   Same anti-pattern as profiles (202610120005): Supabase grants table-wide
--   SELECT to anon/authenticated, so a column-level REVOKE is ineffective
--   against a table-wide grant. Fix: table-level revoke + column whitelist.
--   Financial columns and contact PII are NOT re-granted to anon/authenticated.
--   Owner/team/admin paths use service_role or admin policies, which keep
--   full SELECT.
--
--   Communities final column set (post-migrations):
--     id, name, description, location, banner_url, owner_id, visibility,
--     verification_status, member_count, event_count, created_at, updated_at,
--     deleted_at (202607220001 + 202607230011 drop status),
--     category, city, state, country, contact_email, contact_phone, tags,
--     rules (202607230006),
--     commission_percent, commission_on (202607240006),
--     wallet_balance, cashfree_beneficiary_id (202607280002),
--     instagram_url, facebook_url, twitter_url, linkedin_url (202607300013),
--     community_avatar_url (202608050002),
--     is_hidden (202608020001),
--     platform_fee_amount (202610070001, deprecated).
--
--   GRANTED to anon (public, unauthenticated renders):
--     id, name, description, location, banner_url, community_avatar_url,
--     category, city, state, country, tags, rules, visibility,
--     instagram_url, facebook_url, twitter_url, linkedin_url,
--     owner_id, member_count, event_count, deleted_at, is_hidden,
--     verification_status, created_at, updated_at
--   NOT GRANTED to anon (sensitive — financial/contact):
--     wallet_balance, cashfree_beneficiary_id, commission_percent,
--     commission_on, platform_fee_amount, contact_email, contact_phone
--
--   authenticated keeps the table-wide SELECT (RLS still limits which rows
--   are visible). This is required because organizer-web and admin-web use
--   select("*"): PostgREST rejects a select that returns a column the role
--   lacks, and those apps legitimately render the owner's wallet/contact
--   fields. Closing the anon leak is the security fix; authenticated
--   exposure is row-scoped by RLS.
-- ============================================================================

-- 1. Remove the anon/PUBLIC table-wide grant so the column whitelist below is
--    effective for unauthenticated callers. Leave `authenticated` untouched.
REVOKE SELECT ON public.communities FROM anon, PUBLIC;

-- 2. Re-grant only non-sensitive, publicly-rendered columns to anon.
GRANT SELECT (
  id,
  name,
  description,
  location,
  banner_url,
  community_avatar_url,
  category,
  city,
  state,
  country,
  tags,
  rules,
  visibility,
  instagram_url,
  facebook_url,
  twitter_url,
  linkedin_url,
  owner_id,
  member_count,
  event_count,
  deleted_at,
  is_hidden,
  verification_status,
  created_at,
  updated_at
) ON public.communities TO anon;

-- 3. Also revoke the sensitive columns from PUBLIC (belt-and-braces), but
--    NOT from authenticated.
REVOKE SELECT (
  wallet_balance,
  cashfree_beneficiary_id,
  commission_percent,
  commission_on,
  platform_fee_amount,
  contact_email,
  contact_phone
) ON public.communities FROM anon, PUBLIC;

-- 4. Ensure authenticated keeps the table-wide SELECT explicitly. Some
--    projects inherit this through PUBLIC; the REVOKE above would otherwise
--    remove it and break organizer-web/admin-web select("*").
GRANT SELECT ON public.communities TO authenticated;

-- 5. service_role (edge functions) keeps full access.
GRANT SELECT ON public.communities TO service_role;

-- ============================================================================
-- F-3: waitlist policies role-agnostic
--   waitlist_team_read / waitlist_team_delete let ANY community member
--   (including a plain follower) read AND delete other members' waitlist
--   entries. Recreate with is_community_team() role filter; drop
--   waitlist_team_delete entirely (self-delete already exists).
-- ============================================================================

DROP POLICY IF EXISTS "waitlist_team_read" ON public.waitlist_entries;
CREATE POLICY "waitlist_team_read" ON public.waitlist_entries
  FOR SELECT USING (
    public.is_community_team(
      (SELECT e.community_id FROM public.events e WHERE e.id = event_id)
    )
  );

DROP POLICY IF EXISTS "waitlist_team_delete" ON public.waitlist_entries;
-- waitlist_self_delete (user_id = auth.uid()) is the only DELETE path.

-- ============================================================================
-- F-4: media_team_read role filter
--   Any community member could read media of admin-hidden communities.
--   Recreate with is_community_team() role filter for both branches.
-- ============================================================================

DROP POLICY IF EXISTS "media_team_read" ON public.media;
CREATE POLICY "media_team_read" ON public.media FOR SELECT USING (
  (mediable_type = 'community' AND public.is_community_team(mediable_id))
  OR
  (mediable_type = 'event' AND EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = mediable_id AND public.is_community_team(e.community_id)
  ))
);

-- ============================================================================
-- F-6: reviews_public_read missing visibility='public'
--   Reviews of private communities were world-readable.
--   Add the visibility check (the same file checks it for communities and
--   media, but forgot it here).
-- ============================================================================

DROP POLICY IF EXISTS "reviews_public_read" ON public.reviews;
CREATE POLICY "reviews_public_read" ON public.reviews
  FOR SELECT USING (
    deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.events e JOIN public.communities c ON e.community_id = c.id
      WHERE e.id = event_id AND c.visibility = 'public'
        AND NOT c.is_hidden
    )
  );

-- ============================================================================
-- F-8: search_path hardening on two SECURITY DEFINER functions
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_community_member(community_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS
$$ SELECT EXISTS (
     SELECT 1 FROM public.community_members cm
     WHERE cm.community_id = community_id AND cm.user_id = auth.uid()
   ) $$;

CREATE OR REPLACE FUNCTION public.update_community_member_count()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.communities
    SET member_count = member_count + 1
    WHERE id = NEW.community_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.communities
    SET member_count = GREATEST(member_count - 1, 0)
    WHERE id = OLD.community_id;
  END IF;
  RETURN NULL;
END;
$$;

-- ============================================================================
-- D11: communities.deleted_at added to privileged-column guard
--   An owner could self-soft-delete via a direct PostgREST PATCH
--   (communities_owner_write has no deleted_at filter), bypassing admin
--   audit and event cleanup. Block it for non-admin client roles.
--   Base: admin-exempt version from 202610140005.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_communities_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
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
       OR NEW.deleted_at          IS DISTINCT FROM OLD.deleted_at
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

-- ============================================================================
-- D12: legacy reports table dropped
--   Write-dead in repo code but its INSERT policy (reports_own_write) is
--   still live in the DB — any client can POST /rest/v1/reports, creating
--   dangling target_id rows. Fully superseded by content_reports
--   (202610110004). No readers exist (admin-web reads content_reports only).
--   The reporter_id NO ACTION FK also forced manual pre-delete cleanup in
--   delete-account; dropping the table removes that burden.
-- ============================================================================

DROP TABLE IF EXISTS public.reports CASCADE;

-- ============================================================================
-- D9: rate_limits purge + TTL index
--   check-account stored sha256(email) — a deterministic hash vulnerable to
--   dictionary attack. The raw hashes are purged here; the HMAC-with-pepper
--   upgrade is applied in _shared/rate-limit.ts (code change).
--   TTL index supports the daily purge job.
-- ============================================================================

-- Purge all existing rows so no raw email hashes remain in the table.
TRUNCATE TABLE public.rate_limits;

-- TTL index for the daily purge job (deletes rows older than 24h).
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
  ON public.rate_limits (window_start);
