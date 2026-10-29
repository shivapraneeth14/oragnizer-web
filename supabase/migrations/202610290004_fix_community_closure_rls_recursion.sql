-- ============================================================================
-- CLUVO — Fix infinite recursion in community closure RLS policies
--
-- Problem:
--   202610290001_block_members_of_closure_communities.sql introduced cross-table
--   inline subqueries between `communities`, `community_members`, and `events`
--   in their SELECT RLS policies. When an authenticated or anon user queries
--   `communities` or `events`, Postgres evaluates the policies recursively:
--     communities -> community_members -> communities -> ...
--   which triggers ERROR: 42P17 (infinite recursion detected in policy for
--   relation "communities").
--
-- Fix:
--   1. Introduce SECURITY DEFINER helper functions (SET search_path = '') that
--      inspect table state with database owner privileges without triggering
--      caller RLS evaluation during subqueries.
--   2. Replace the circular inline subqueries in all five closure policies with
--      these SECURITY DEFINER helpers.
--   3. Ensure community owners can read their community row even during closure
--      grace so organizer-web can render the closure notice rather than erroring.
-- ============================================================================

-- 1. Helper: check if a community is currently in closure grace
CREATE OR REPLACE FUNCTION public.is_community_in_closure_grace(p_community_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.communities c
    WHERE c.id = p_community_id
      AND c.deletion_grace_started_at IS NOT NULL
      AND c.closed_at IS NULL
  );
$$;

-- 2. Helper: check if a user is a member of a community
CREATE OR REPLACE FUNCTION public.is_user_member_of_community(p_community_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.community_members cm
    WHERE cm.community_id = p_community_id
      AND cm.user_id = p_user_id
  );
$$;

-- 3. Helper: get community_id of an event
CREATE OR REPLACE FUNCTION public.get_event_community_id(p_event_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT community_id FROM public.events WHERE id = p_event_id;
$$;

-- Grant EXECUTE permissions
GRANT EXECUTE ON FUNCTION public.is_community_in_closure_grace(uuid) TO public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_user_member_of_community(uuid, uuid) TO public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_event_community_id(uuid) TO public, anon, authenticated, service_role;

-- 4. Recreate communities policy
DROP POLICY IF EXISTS "block_closure_communities_select" ON public.communities;
CREATE POLICY "block_closure_communities_select" ON public.communities
AS RESTRICTIVE
FOR SELECT
USING (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    -- Community owners need to be able to read their community row in closure grace
    -- to see the closure notice banner in organizer-web
    WHEN public.is_community_owner(id) THEN true
    WHEN deletion_grace_started_at IS NOT NULL AND closed_at IS NULL THEN (
      NOT public.is_user_member_of_community(id, auth.uid())
    )
    ELSE true
  END
);

-- 5. Recreate events policy
DROP POLICY IF EXISTS "block_closure_events_select" ON public.events;
CREATE POLICY "block_closure_events_select" ON public.events
AS RESTRICTIVE
FOR SELECT
USING (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    WHEN public.is_community_owner(community_id) THEN true
    WHEN public.is_community_in_closure_grace(community_id) THEN (
      NOT public.is_user_member_of_community(community_id, auth.uid())
    )
    ELSE true
  END
);

-- 6. Recreate community_members policy
DROP POLICY IF EXISTS "block_closure_community_members_select" ON public.community_members;
CREATE POLICY "block_closure_community_members_select" ON public.community_members
AS RESTRICTIVE
FOR SELECT
USING (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    WHEN public.is_community_owner(community_id) THEN true
    WHEN public.is_community_in_closure_grace(community_id) THEN (
      user_id <> auth.uid()
      AND NOT public.is_user_member_of_community(community_id, auth.uid())
    )
    ELSE true
  END
);

-- 7. Recreate registrations policy
DROP POLICY IF EXISTS "block_closure_registrations_select" ON public.registrations;
CREATE POLICY "block_closure_registrations_select" ON public.registrations
AS RESTRICTIVE
FOR SELECT
USING (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    WHEN public.is_community_owner(public.get_event_community_id(event_id)) THEN true
    WHEN public.is_community_in_closure_grace(public.get_event_community_id(event_id)) THEN (
      user_id <> auth.uid()
      AND NOT public.is_user_member_of_community(public.get_event_community_id(event_id), auth.uid())
    )
    ELSE true
  END
);

-- 8. Recreate join_requests policy
DROP POLICY IF EXISTS "block_closure_join_requests" ON public.join_requests;
CREATE POLICY "block_closure_join_requests" ON public.join_requests
AS RESTRICTIVE
FOR ALL
USING (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    WHEN public.is_community_owner(community_id) THEN true
    WHEN public.is_community_in_closure_grace(community_id) THEN (
      user_id <> auth.uid()
      AND NOT public.is_user_member_of_community(community_id, auth.uid())
    )
    ELSE true
  END
)
WITH CHECK (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    WHEN public.is_community_in_closure_grace(community_id) THEN false
    ELSE true
  END
);
