-- ============================================================================
-- CLUVO — Prevent updates to cancelled events
--
-- Problem
--   Cancelled events can be edited and republished via direct UPDATE to events.
--   The cancel flow issues refunds and cancels registrations; republishing a
--   cancelled event would create inconsistent state.
--
-- Fix
--   1) Tighten events_team_update RLS so existing cancelled events cannot be
--      updated by authenticated team members/owners. (Service role bypasses
--      RLS so the cancel-event function remains unaffected.)
--   2) Add a BEFORE UPDATE trigger as defense in depth to block any update to
--      a row where OLD.status = 'cancelled'. This still allows setting status
--      TO 'cancelled' from non-cancelled states.
-- ============================================================================

-- 1) RLS policy
DROP POLICY IF EXISTS events_team_update ON public.events;
CREATE POLICY events_team_update ON public.events FOR UPDATE
  USING (
    (public.is_community_owner(community_id) OR public.is_community_team(community_id))
    AND status <> 'cancelled'
  )
  WITH CHECK (
    (public.is_community_owner(community_id) OR public.is_community_team(community_id))
    AND status <> 'cancelled'
  );

-- 2) Trigger as defense in depth
CREATE OR REPLACE FUNCTION public.prevent_cancelled_event_updates()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot update a cancelled event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_cancelled_event_updates ON public.events;
CREATE TRIGGER trg_prevent_cancelled_event_updates
  BEFORE UPDATE ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_cancelled_event_updates();
