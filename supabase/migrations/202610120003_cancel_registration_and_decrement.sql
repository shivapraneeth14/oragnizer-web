-- ============================================================================
-- CLUVO - A3: idempotent capacity bookkeeping on cancellation
--
-- Problem: cancel flows did read-then-update-then-decrement:
--   registrations.status='cancelled'; then decrement_event_booked(event_id).
-- Two concurrent cancels of the SAME registration both pass the read guard,
-- both "update" (the second is a row no-op but still proceeds) and both call
-- decrement_event_booked -> events.booked_count drops by 2 for 1 cancellation.
-- A cancel racing a late webhook confirm could likewise over-decrement.
--
-- Fix: fold the cancel + decrement into ONE transaction that only decrements
-- when the registration actually transitioned confirmed -> cancelled.
--   - status IN ('confirmed','pending') + deleted_at IS NULL are cancelled
--     (event-cancellation must also close unpaid pendings);
--   - booked_count is decremented ONLY when the prior status was 'confirmed'
--     (a pending registration was never counted by confirm_payment);
--   - a second cancel of the same registration is a no-op (no decrement).
--
-- Callers keep using this exact RPC instead of update + decrement_event_booked.
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
  UPDATE public.registrations
  SET status = 'cancelled',
      qr_code = NULL,
      deleted_at = COALESCE(p_deleted_at, now()),
      updated_at = now()
  WHERE id = p_registration_id
    AND status IN ('confirmed', 'pending')
    AND deleted_at IS NULL
  RETURNING status, event_id
  INTO v_prior_status, v_event_id;

  IF NOT FOUND THEN
    -- Already cancelled/deleted: nothing booked to release.
    RETURN FALSE;
  END IF;

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