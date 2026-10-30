-- ============================================================================
-- Migration: 202611010001_incoming_payment_remediation.sql
-- Description: Stage 5 Incoming Payment Concurrency, Reliability & Security Fixes:
--   1. PAY-CONC-001: Temporary capacity reservations (holds) and atomic active hold counting
--   2. PAY-REL-002: Atomic webhook deduplication and payment confirmation RPC
--   3. PAY-SEC-003: Partial unique index on payments.razorpay_payment_id
--   4. PAY-SEC-004: Dual-path amount and currency assertion guards
--   5. PAY-CONC-005: Safe double-tap registration handling with unified lock hierarchy
-- ============================================================================

-- 1. Schema Extensions for Temporary Holds (PAY-CONC-001)
ALTER TABLE public.registrations
  ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ DEFAULT NULL;

-- High-performance partial index for sub-millisecond active hold calculations
CREATE INDEX IF NOT EXISTS idx_registrations_active_holds 
  ON public.registrations (event_id, hold_expires_at) 
  WHERE status = 'pending' AND hold_expires_at IS NOT NULL;

-- 2. Unique Constraint on Provider Payment ID (PAY-SEC-003)
-- Pre-migration safety validation: assert zero duplicate non-null payment IDs exist
DO $$
DECLARE
  v_dupe_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_dupe_count
  FROM (
    SELECT razorpay_payment_id
    FROM public.payments
    WHERE razorpay_payment_id IS NOT NULL
    GROUP BY razorpay_payment_id
    HAVING COUNT(*) > 1
  ) dupes;

  IF v_dupe_count > 0 THEN
    RAISE EXCEPTION 'Cannot apply unique index: % duplicate razorpay_payment_id groups exist', v_dupe_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_razorpay_payment_id 
  ON public.payments (razorpay_payment_id) 
  WHERE razorpay_payment_id IS NOT NULL;

-- 3. Atomic Ticket Capacity Reservation RPC (PAY-CONC-001, PAY-CONC-005)
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

  -- Guard: Confirmed or Attended registrations must NEVER be overwritten
  IF FOUND AND v_reg.status IN ('confirmed', 'attended') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_registered', 'message', 'You are already registered for this event');
  END IF;

  -- Global Lock Hierarchy Level 3: Check Linked Payment (if exists)
  IF FOUND THEN
    SELECT id, status, refund_status, refund_claim_state
    INTO v_payment
    FROM public.payments
    WHERE registration_id = v_reg.id
    FOR UPDATE;

    IF FOUND THEN
      -- Guard against already paid row
      IF v_payment.status = 'success' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'already_paid', 'message', 'You have already paid for this event');
      END IF;

      -- Guard against in-flight refund
      IF v_payment.refund_claim_state = 'claimed' 
         OR (v_payment.refund_status IS NOT NULL AND v_payment.refund_status NOT IN ('processed', 'failed')) THEN
        RETURN jsonb_build_object(
          'ok', false, 
          'error', 'refund_in_progress', 
          'message', 'A refund for your previous booking is being processed. You can rebook once it completes.'
        );
      END IF;

      -- Reuse active hold if user taps Book again within 10 minutes
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

REVOKE ALL PRIVILEGES ON FUNCTION public.reserve_ticket_capacity(UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_ticket_capacity(UUID, UUID, INTEGER) TO service_role;

-- 4. Release Ticket Capacity RPC
CREATE OR REPLACE FUNCTION public.release_ticket_capacity(p_registration_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.registrations
  SET hold_expires_at = NULL,
      status = 'cancelled',
      updated_at = clock_timestamp()
  WHERE id = p_registration_id
    AND status = 'pending';

  RETURN jsonb_build_object('ok', true, 'released', FOUND);
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.release_ticket_capacity(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_ticket_capacity(UUID) TO service_role;

-- 5. Refactored confirm_payment RPC (Unified Lock Hierarchy & Security Validation)
CREATE OR REPLACE FUNCTION public.confirm_payment(
  p_payment_id UUID,
  p_expected_amount INTEGER DEFAULT NULL,
  p_expected_currency TEXT DEFAULT 'INR',
  p_razorpay_payment_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment RECORD;
  v_reg RECORD;
  v_event RECORD;
  v_community RECORD;
  v_updated INTEGER;
  v_platform_fee INTEGER;
  v_platform_fee_gst INTEGER;
  v_organizer_share INTEGER;
  v_reg_id UUID;
  v_event_id UUID;
BEGIN
  -- Set transaction lock timeout to avoid indefinite queuing
  SET LOCAL lock_timeout = '3s';

  -- Step 0: Non-locking lookup to determine foreign key hierarchy
  SELECT p.registration_id, r.event_id
  INTO v_reg_id, v_event_id
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  WHERE p.id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment or registration not found');
  END IF;

  -- Level 1: Lock Event Row FIRST
  SELECT * INTO v_event
  FROM public.events
  WHERE id = v_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Event not found');
  END IF;

  -- Level 2: Lock Registration Row SECOND
  SELECT * INTO v_reg
  FROM public.registrations
  WHERE id = v_reg_id
  FOR UPDATE;

  -- Level 3: Lock Payment Row THIRD
  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  -- Record provider payment ID if provided
  IF p_razorpay_payment_id IS NOT NULL AND v_payment.razorpay_payment_id IS NULL THEN
    UPDATE public.payments
    SET razorpay_payment_id = p_razorpay_payment_id
    WHERE id = p_payment_id;
    v_payment.razorpay_payment_id := p_razorpay_payment_id;
  END IF;

  -- Security Validations (PAY-SEC-004)
  IF p_expected_amount IS NOT NULL AND v_payment.amount != p_expected_amount THEN
    RETURN jsonb_build_object('error', 'Amount mismatch', 'code', 400);
  END IF;

  IF p_expected_currency IS NOT NULL AND v_payment.currency != p_expected_currency THEN
    RETURN jsonb_build_object('error', 'Currency mismatch', 'code', 400);
  END IF;

  -- Idempotency: Already confirmed or refunded
  IF v_payment.status IN ('success', 'refunded') THEN
    RETURN jsonb_build_object('skipped', true, 'payment_id', p_payment_id);
  END IF;

  -- Guard: Cancelled registration
  IF v_reg.status = 'cancelled' THEN
    UPDATE public.payments
    SET status = 'failed',
        failure_reason = 'registration_cancelled',
        refund_reason = COALESCE(refund_reason, 'registration_cancellation')
    WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id, 'reason', 'registration_cancellation');
  END IF;

  -- Guard: Cancelled or Cancelling Event
  IF v_event.status IN ('cancelled', 'cancelling') THEN
    UPDATE public.payments
    SET status = 'failed',
        failure_reason = 'event_cancelled',
        refund_reason = COALESCE(refund_reason, 'event_cancellation')
    WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id, 'reason', 'event_cancellation');
  END IF;

  -- Atomic Capacity Increment
  UPDATE public.events e SET booked_count = booked_count + 1
  WHERE e.id = v_event.id
    AND (e.capacity IS NULL OR e.booked_count < e.capacity);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    UPDATE public.payments
    SET status = 'failed',
        failure_reason = 'capacity_full',
        refund_reason = COALESCE(refund_reason, 'capacity_full')
    WHERE id = p_payment_id;

    UPDATE public.registrations
    SET status = 'cancelled',
        hold_expires_at = NULL
    WHERE id = v_reg_id;

    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id, 'reason', 'capacity_full');
  END IF;

  -- Fee and Split Math
  v_platform_fee := GREATEST(COALESCE(v_payment.platform_fee, 0), 0);
  v_platform_fee_gst := GREATEST(COALESCE(v_payment.platform_fee_gst, 0), 0);
  v_organizer_share := GREATEST(v_payment.amount - v_platform_fee, 0);

  UPDATE public.payments
  SET status = 'success',
      platform_fee = v_platform_fee,
      platform_fee_gst = v_platform_fee_gst,
      organizer_share = v_organizer_share,
      failure_reason = NULL,
      updated_at = clock_timestamp()
  WHERE id = p_payment_id;

  UPDATE public.registrations
  SET status = 'confirmed',
      hold_expires_at = NULL,
      qr_code = encode(sha256((p_payment_id::text || v_event.id::text || v_reg_id::text)::bytea), 'hex'),
      updated_at = clock_timestamp()
  WHERE id = v_reg_id;

  -- Level 4: Wallet Credit
  SELECT * INTO v_community FROM public.communities WHERE id = v_event.community_id;
  PERFORM public.credit_wallet(v_community.id, v_organizer_share, v_event.id);

  IF v_reg.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, title, body, type)
    VALUES (
      v_reg.user_id,
      'Booking Confirmed!',
      'Your ticket for "' || v_event.title || '" is confirmed.',
      'booking'
    );
  END IF;

  RETURN jsonb_build_object('action', 'confirmed', 'payment_id', p_payment_id);
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_payment(UUID, INTEGER, TEXT, TEXT) TO service_role;

-- 6. Atomic Webhook Confirmation RPC (PAY-REL-002, PAY-SEC-004)
CREATE OR REPLACE FUNCTION public.confirm_payment_from_webhook(
  p_payment_id UUID,
  p_webhook_id TEXT,
  p_razorpay_payment_id TEXT,
  p_expected_amount INTEGER,
  p_expected_currency TEXT DEFAULT 'INR'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_confirm_res JSONB;
BEGIN
  -- Check if webhook event already processed (idempotency)
  IF EXISTS (SELECT 1 FROM public.processed_webhooks WHERE id = p_webhook_id) THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'already_processed');
  END IF;

  -- Execute payment confirmation with strict lock hierarchy and security validations
  v_confirm_res := public.confirm_payment(
    p_payment_id => p_payment_id,
    p_expected_amount => p_expected_amount,
    p_expected_currency => p_expected_currency,
    p_razorpay_payment_id => p_razorpay_payment_id
  );

  IF v_confirm_res->>'error' IS NOT NULL THEN
    RETURN v_confirm_res;
  END IF;

  -- Atomically record webhook deduplication inside the same transaction
  INSERT INTO public.processed_webhooks (id, provider, event_type, created_at)
  VALUES (p_webhook_id, 'razorpay', 'payment.captured', clock_timestamp())
  ON CONFLICT (id) DO NOTHING;

  RETURN v_confirm_res;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment_from_webhook(UUID, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_payment_from_webhook(UUID, TEXT, TEXT, INTEGER, TEXT) TO service_role;

