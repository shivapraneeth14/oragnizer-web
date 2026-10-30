-- ============================================================================
-- CLUVO STAGE 6 PHASE 2 — BUG-005: Atomic Free-Event Registration RPC
--
-- Single database transaction executing:
--   1. Global Lock Hierarchy Level 1: Lock Event row FOR UPDATE.
--   2. Event state, schedule, pricing and community closure validation.
--   3. Global Lock Hierarchy Level 2: Lock User Registration row FOR UPDATE.
--   4. Capture v_reg_exists explicitly (independent of subsequent SQL FOUND).
--   5. Idempotent short-circuit if registration is already confirmed or attended.
--   6. Dynamic capacity check accounting for active checkout holds.
--   7. Atomic booked_count increment on events.
--   8. Atomic registration insert or status restoration.
--   9. Strict privilege boundary: service_role only (blocked from anon/auth).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.register_free_event(
  p_event_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event RECORD;
  v_reg RECORD;
  v_reg_exists BOOLEAN := FALSE;
  v_active_holds INTEGER := 0;
  v_reg_id UUID;
  v_qr_code TEXT;
BEGIN
  -- Strict lock timeout to prevent queueing under high contention
  SET LOCAL lock_timeout = '3s';

  -- Security Gate: Assert caller authorization if called within an authenticated JWT session
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id AND NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Cannot register on behalf of another user');
  END IF;

  -- Global Lock Hierarchy Level 1: Lock Event Row FIRST
  SELECT id, community_id, capacity, booked_count, status, deleted_at, start_date, price
  INTO v_event
  FROM public.events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event_not_found', 'message', 'Event not found');
  END IF;

  IF v_event.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event_deleted', 'message', 'This event has been deleted');
  END IF;

  IF v_event.status IN ('cancelled', 'cancelling') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event_cancelled', 'message', 'This event has been cancelled');
  END IF;

  IF v_event.status = 'completed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event_completed', 'message', 'This event has ended');
  END IF;

  IF v_event.status != 'published' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event_unavailable', 'message', 'This event is not available');
  END IF;

  IF v_event.start_date IS NOT NULL AND v_event.start_date < clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event_started', 'message', 'This event has already started');
  END IF;

  -- Enforce Free Event Scope: Must have zero price
  IF COALESCE(v_event.price, 0) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payment_required', 'message', 'Please proceed to payment');
  END IF;

  -- Community Closure Grace Guard
  IF public.is_community_in_closure_grace(v_event.community_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'community_closing', 'message', 'Cannot register while community closure is scheduled');
  END IF;

  -- Global Lock Hierarchy Level 2: Lock User Registration Row SECOND (if exists)
  SELECT id, status, qr_code
  INTO v_reg
  FROM public.registrations
  WHERE event_id = p_event_id AND user_id = p_user_id
  FOR UPDATE;

  -- Explicitly capture existence before any subsequent SQL statement clobbers FOUND
  v_reg_exists := FOUND;

  -- Idempotency Guard: Sequential double-taps return existing ticket without incrementing count
  IF v_reg_exists AND v_reg.status IN ('confirmed', 'attended') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_registered', true,
      'registration_id', v_reg.id,
      'booked_count', v_event.booked_count
    );
  END IF;

  -- Concurrency-Safe Capacity Check incorporating active checkout holds
  IF v_event.capacity IS NOT NULL THEN
    SELECT COALESCE(COUNT(*), 0)
    INTO v_active_holds
    FROM public.registrations
    WHERE event_id = p_event_id
      AND status = 'pending'
      AND hold_expires_at > clock_timestamp()
      AND (NOT v_reg_exists OR id != v_reg.id);

    IF (v_event.booked_count + v_active_holds + 1) > v_event.capacity THEN
      RETURN jsonb_build_object('ok', false, 'error', 'capacity_full', 'message', 'Event is full');
    END IF;
  END IF;

  -- Deterministic QR code hash
  v_qr_code := encode(sha256(('free_' || p_event_id::text || '_' || p_user_id::text || '_' || clock_timestamp()::text)::bytea), 'hex');

  -- Atomically increment event booked_count
  UPDATE public.events
  SET booked_count = booked_count + 1,
      updated_at = clock_timestamp()
  WHERE id = p_event_id;

  -- Atomically create or restore confirmed registration
  IF v_reg_exists THEN
    UPDATE public.registrations
    SET status = 'confirmed',
        hold_expires_at = NULL,
        qr_code = v_qr_code,
        registered_at = clock_timestamp(),
        deleted_at = NULL,
        updated_at = clock_timestamp()
    WHERE id = v_reg.id;
    v_reg_id := v_reg.id;
  ELSE
    INSERT INTO public.registrations (
      event_id,
      user_id,
      status,
      qr_code,
      hold_expires_at,
      registered_at,
      updated_at
    ) VALUES (
      p_event_id,
      p_user_id,
      'confirmed',
      v_qr_code,
      NULL,
      clock_timestamp(),
      clock_timestamp()
    ) RETURNING id INTO v_reg_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'already_registered', false,
    'registration_id', v_reg_id,
    'booked_count', v_event.booked_count + 1
  );
END;
$$;

-- Strict Service-Role Isolation: Direct client invocation revoked
REVOKE ALL PRIVILEGES ON FUNCTION public.register_free_event(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_free_event(UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.register_free_event(UUID, UUID) IS
  'Atomically verifies event capacity against booked_count and active holds, increments booked_count, and commits confirmed registration in a single transaction.';

