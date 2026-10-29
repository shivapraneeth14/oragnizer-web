-- ============================================================================
-- CLUVO — Retire private communities (product decision) + close the event leak
--
-- Context
--   The clients never exposed a private toggle (the signup form hardcodes
--   visibility: "public"), but both community edge functions accepted
--   "private" from a direct API call, and the DB CHECK allows it. Legacy
--   private rows also still leak their published events because
--   events_public_read (202608020002) only checks status/deleted_at and the
--   admin-hidden flag — it never checks communities.visibility.
--
-- What this does
--   1. communities: reject any new private row and any public -> private
--      change. Existing private rows keep working (private -> private is
--      allowed) so legacy data is never silently exposed or broken.
--   2. events: public read now also requires a public, live, non-hidden
--      community. This protects the legacy private rows that can no longer
--      be created. Registered attendees, team and admins keep their own
--      policies.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. No new private communities, from any role.
--    Product-level constraint (not an authz guard), so service_role is not
--    exempt: re-enabling private requires a deliberate migration.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_public_communities()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.visibility IS DISTINCT FROM 'public' THEN
      RAISE EXCEPTION 'Private communities are not supported'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Allow legacy private rows to stay private (and to be made public);
    -- block public -> private and any other non-public target.
    IF NEW.visibility IS DISTINCT FROM OLD.visibility
       AND NEW.visibility IS DISTINCT FROM 'public' THEN
      RAISE EXCEPTION 'Private communities are not supported'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_communities_public_only ON public.communities;
CREATE TRIGGER trg_communities_public_only
  BEFORE INSERT OR UPDATE ON public.communities
  FOR EACH ROW EXECUTE FUNCTION public.enforce_public_communities();

-- ---------------------------------------------------------------------------
-- 2. Published events are public only when their community is public.
--    Same shape as communities_public_read, so a legacy private community's
--    events cannot be discovered (or fetched by id) by non-members.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "events_public_read" ON public.events;
CREATE POLICY "events_public_read" ON public.events
  FOR SELECT USING (
    status = 'published'
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.communities c
      WHERE c.id = events.community_id
        AND c.visibility = 'public'
        AND c.deleted_at IS NULL
        AND c.is_hidden = false
    )
  );
