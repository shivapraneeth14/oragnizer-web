-- ============================================================================
-- CLUVO - A3 follow-up: capture PRE-update status in the cancel RPC
--
-- Bug: 202610120003 used `UPDATE ... RETURNING status ... INTO v_prior_status`.
-- PostgreSQL's RETURNING yields the NEW row for an UPDATE, so v_prior_status
-- was always 'cancelled'; the `IF v_prior_status = 'confirmed'` guard never
-- fired and events.booked_count was NEVER decremented on cancellation.
--
-- Fix: lock the row and read its prior status BEFORE updating it, then
-- decrement based on that captured prior status. Concurrent cancels serialize
-- on the row lock: the loser re-evaluates the predicate against the now
-- 'cancelled' row and finds no match, so there is no double decrement.
--
-- Behaviour is otherwise identical to 202610120003 (status IN
-- ('confirmed','pending') + deleted_at IS NULL are cancelled; booked_count is
-- decremented only when the prior status was 'confirmed').
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cancel_registration_and_decrement(
  p_registration_id UUID,
  p_deleted_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prior_status TEXT;
  v_event_id UUID;
BEGIN
  SELECT r.status, r.event_id
  INTO v_prior_status, v_event_id
  FROM public.registrations r
  WHERE r.id = p_registration_id
    AND r.status IN ('confirmed', 'pending')
    AND r.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Already cancelled/deleted: nothing booked to release.
    RETURN FALSE;
  END IF;

  UPDATE public.registrations
  SET status = 'cancelled',
      qr_code = NULL,
      deleted_at = COALESCE(p_deleted_at, now()),
      updated_at = now()
  WHERE id = p_registration_id;

  -- Only a registration that counted against capacity is decremented.
  IF v_prior_status = 'confirmed' AND v_event_id IS NOT NULL THEN
    UPDATE public.events
    SET booked_count = GREATEST(0, booked_count - 1)
    WHERE id = v_event_id;
  END IF;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION public.cancel_registration_and_decrement(UUID, TIMESTAMPTZ) IS
  'Cancel a registration and decrement events.booked_count iff it was confirmed (exactly once, atomic)';

REVOKE ALL PRIVILEGES ON FUNCTION public.cancel_registration_and_decrement(UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_registration_and_decrement(UUID, TIMESTAMPTZ) TO service_role;
