-- ============================================================================
-- CLUVO — Admin per-community event counts (read-only)
--
-- Problem:
--   public.communities.event_count is a stored counter that is never updated
--   when events are inserted/deleted, so the admin communities list shows 0
--   even when a community has events.
--
-- Solution:
--   Add a read-only, admin-only RPC that counts the actual event rows grouped
--   by community_id. No table data, triggers, or existing routines change.
--   "All events" means every row in public.events: no status/deleted_at filter.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_community_event_counts()
RETURNS TABLE (community_id uuid, event_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.community_id, COUNT(*)::bigint AS event_count
  FROM public.events e
  WHERE public.is_admin_user()
  GROUP BY e.community_id;
$$;

REVOKE ALL ON FUNCTION public.admin_community_event_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_community_event_counts() TO authenticated, service_role;

COMMENT ON FUNCTION public.admin_community_event_counts() IS
  'Admin-only read-only count of every event row per community (no status or deleted_at filter).';
