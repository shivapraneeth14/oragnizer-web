-- ============================================================================
-- CLUVO STAGE 5 REMEDIATION — FIX 3: PAY-CONC-007
-- Move active hold reuse check outside the payments lookup block in
-- reserve_ticket_capacity so sequential user taps return reused_hold=true
-- both before and after payment row insertion.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reserve_ticket_capacity(
  p_event_id UUID,
  p_user_id UUID,
  p_hold_duration_seconds INTEGER DEFAULT 600 -- 10 minutes
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event RECORD;
  v_active_holds INTEGER := 0;
  v_reg RECORD;
  v_payment RECORD;
  v_hold_expires TIMESTAMPTZ;
  v_reg_id UUID;
BEGIN
  -- Global Lock Hierarchy Level 1: Lock Event Row FIRST
  SELECT id, capacity, booked_count, status, deleted_at, start_date, price
  INTO v_event
  FROM public.events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event_not_found', 'message', 'Event not found');
  END IF;

  IF v_event.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event_deleted', 'message', 'Event has been deleted');
  END IF;

  -- Event Freeze: Block reservations on cancelling or cancelled events immediately
  IF v_event.status IN ('cancelled', 'cancelling') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event_cancelled', 'message', 'Event has been cancelled');
  END IF;

  IF v_event.status != 'published' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event_unavailable', 'message', 'Event is not available');
  END IF;

  IF v_event.start_date IS NOT NULL AND v_event.start_date < clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event_started', 'message', 'Event has already started');
  END IF;

  -- Global Lock Hierarchy Level 2: Lock User Registration (if exists)
  SELECT id, status, hold_expires_at
  INTO v_reg
  FROM public.registrations
  WHERE event_id = p_event_id AND user_id = p_user_id
  FOR UPDATE;

  -- If registration exists, enforce guards and check for hold reuse
  IF FOUND THEN
    -- Guard 1: Confirmed or Attended registrations must NEVER be overwritten
    IF v_reg.status IN ('confirmed', 'attended') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'already_registered', 'message', 'You are already registered for this event');
    END IF;

    -- Global Lock Hierarchy Level 3: Check Linked Payment (if exists)
    SELECT id, status, refund_status, refund_claim_state
    INTO v_payment
    FROM public.payments
    WHERE registration_id = v_reg.id
    FOR UPDATE;

    IF FOUND THEN
      -- Guard 2: Guard against already paid row
      IF v_payment.status = 'success' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'already_paid', 'message', 'You have already paid for this event');
      END IF;

      -- Guard 3: Guard against in-flight refund
      IF v_payment.refund_claim_state = 'claimed' 
         OR (v_payment.refund_status IS NOT NULL AND v_payment.refund_status NOT IN ('processed', 'failed')) THEN
        RETURN jsonb_build_object(
          'ok', false, 
          'error', 'refund_in_progress', 
          'message', 'A refund for your previous booking is being processed. You can rebook once it completes.'
        );
      END IF;
    END IF;

    -- Hold Reuse Guard: Active hold reuse check moved OUTSIDE payments block (PAY-CONC-007)
    -- Operates whether payment record has been inserted yet or not
    IF v_reg.status = 'pending' AND v_reg.hold_expires_at > clock_timestamp() THEN
      RETURN jsonb_build_object(
        'ok', true,
        'registration_id', v_reg.id,
        'hold_expires_at', v_reg.hold_expires_at,
        'price', v_event.price,
        'reused_hold', true
      );
    END IF;
  END IF;

  -- Calculate Available Capacity: booked_count + active_unexpired_holds
  IF v_event.capacity IS NOT NULL THEN
    SELECT COUNT(*) INTO v_active_holds
    FROM public.registrations
    WHERE event_id = p_event_id
      AND status = 'pending'
      AND hold_expires_at > clock_timestamp()
      AND (v_reg.id IS NULL OR id != v_reg.id);

    IF (v_event.booked_count + v_active_holds) >= v_event.capacity THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'capacity_held',
        'message', 'All available tickets are currently reserved in checkout. Please try again in a few minutes if a reservation expires.'
      );
    END IF;
  END IF;

  -- Calculate Hold Expiry
  v_hold_expires := clock_timestamp() + (p_hold_duration_seconds || ' seconds')::interval;

  -- Atomic Upsert with Strict WHERE Predicate
  IF v_reg.id IS NOT NULL THEN
    UPDATE public.registrations
    SET status = 'pending',
        hold_expires_at = v_hold_expires,
        updated_at = clock_timestamp(),
        deleted_at = NULL
    WHERE id = v_reg.id
      AND status NOT IN ('confirmed', 'attended')
    RETURNING id INTO v_reg_id;
  ELSE
    INSERT INTO public.registrations (
      event_id, user_id, status, hold_expires_at, registered_at, updated_at
    ) VALUES (
      p_event_id, p_user_id, 'pending', v_hold_expires, clock_timestamp(), clock_timestamp()
    )
    ON CONFLICT (event_id, user_id) DO UPDATE
    SET status = 'pending',
        hold_expires_at = EXCLUDED.hold_expires_at,
        updated_at = clock_timestamp(),
        deleted_at = NULL
    WHERE public.registrations.status NOT IN ('confirmed', 'attended')
    RETURNING id INTO v_reg_id;
  END IF;

  IF v_reg_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_registered', 'message', 'You are already registered for this event');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'registration_id', v_reg_id,
    'hold_expires_at', v_hold_expires,
    'price', v_event.price,
    'reused_hold', false
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.reserve_ticket_capacity(UUID, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_ticket_capacity(UUID, UUID, INTEGER) TO service_role;

