-- CLUVO — Event Capacity & Status Mutation Guards
-- Item 2 of Stage 6 Phase 1 Remediation (BUG-003)
-- Guarantees event capacity cannot be reduced below booked_count or active holds.
-- Prevents published events with registrations from reverting to draft.
-- Preserves event cancellation and completion workflows.

-- 1. Table CHECK Constraints
ALTER TABLE public.events 
  DROP CONSTRAINT IF EXISTS chk_event_capacity_non_negative,
  ADD CONSTRAINT chk_event_capacity_non_negative 
  CHECK (capacity IS NULL OR capacity > 0);

ALTER TABLE public.events 
  DROP CONSTRAINT IF EXISTS chk_event_capacity_ge_booked,
  ADD CONSTRAINT chk_event_capacity_ge_booked 
  CHECK (capacity IS NULL OR capacity >= booked_count);

-- 2. Dynamic BEFORE UPDATE Trigger Function
CREATE OR REPLACE FUNCTION public.check_event_capacity_and_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_active_holds INTEGER := 0;
BEGIN
  -- A. Prevent non-positive capacity
  IF NEW.capacity IS NOT NULL AND NEW.capacity <= 0 THEN
    RAISE EXCEPTION 'invalid_event_capacity: Event capacity must be greater than zero (given %)', NEW.capacity;
  END IF;

  -- B. Prevent capacity reduction below confirmed registrations
  IF NEW.capacity IS NOT NULL AND NEW.capacity < NEW.booked_count THEN
    RAISE EXCEPTION 'capacity_below_booked_count: Cannot reduce event capacity (%) below confirmed registrations (%)', 
      NEW.capacity, NEW.booked_count;
  END IF;

  -- C. Prevent capacity reduction below total committed (confirmed + active holds)
  IF NEW.capacity IS NOT NULL AND (OLD.capacity IS NULL OR NEW.capacity < OLD.capacity) THEN
    SELECT COUNT(*)
    INTO v_active_holds
    FROM public.registrations
    WHERE event_id = NEW.id
      AND status = 'pending'
      AND hold_expires_at > clock_timestamp();

    IF NEW.capacity < (NEW.booked_count + v_active_holds) THEN
      RAISE EXCEPTION 'capacity_below_active_holds: Cannot reduce capacity (%) below confirmed registrations and active checkouts (% confirmed + % held)', 
        NEW.capacity, NEW.booked_count, v_active_holds;
    END IF;
  END IF;

  -- D. Status Protection: Prevent published events with active registrations from reverting to draft
  IF NEW.status = 'draft' AND OLD.status != 'draft' THEN
    IF NEW.booked_count > 0 OR EXISTS (
      SELECT 1 FROM public.registrations
      WHERE event_id = NEW.id
        AND status IN ('confirmed', 'attended', 'pending')
    ) THEN
      RAISE EXCEPTION 'cannot_revert_published_event: Cannot revert event to draft when active bookings or holds exist';
    END IF;
  END IF;

  -- E. Preservation of Valid Cancellation and Completion
  -- Transitions to 'cancelling', 'cancelled', and 'completed' pass through cleanly.
  RETURN NEW;
END;
$$;

-- Revoke execute from public/anon, grant to authenticated and service_role
REVOKE ALL PRIVILEGES ON FUNCTION public.check_event_capacity_and_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_event_capacity_and_status() TO authenticated, service_role;

-- 3. Trigger Definition
DROP TRIGGER IF EXISTS trg_events_capacity_and_status_guard ON public.events;
CREATE TRIGGER trg_events_capacity_and_status_guard
  BEFORE UPDATE ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.check_event_capacity_and_status();

