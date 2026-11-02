-- ============================================================================
-- CLUVO STAGE 6 REMEDIATION — MIGRATION 14:
-- REF-001: Atomic Cancellation and Durable Refund Claim Acquisition
-- REF-002: Restore Attended Registration Refund Protection (Lock Order 2 -> 3)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. cancel_registration_and_claim_refund(p_payment_id, p_caller_id)
--    Coordinates registration cancellation, exactly-once capacity decrement,
--    and durable refund claim/debt acquisition in ONE atomic transaction.
--    Eliminates the crash window where registration is cancelled but no refund
--    debt is recorded.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_registration_and_claim_refund(
  p_payment_id UUID,
  p_caller_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reg_id UUID;
  v_event_id UUID;
  v_community_id UUID;
  v_reg_status TEXT;
  v_booked_count_decremented BOOLEAN := FALSE;
  v_payment RECORD;
BEGIN
  -- Step 0: Identify foreign keys
  SELECT p.registration_id, r.event_id, e.community_id
  INTO v_reg_id, v_event_id, v_community_id
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  JOIN public.events e ON e.id = r.event_id
  WHERE p.id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment or registration not found');
  END IF;

  -- 1. Authorization: Verify caller is community owner, organizer/moderator, or platform admin
  IF NOT (
    EXISTS (SELECT 1 FROM public.communities c WHERE c.id = v_community_id AND c.owner_id = p_caller_id)
    OR EXISTS (
      SELECT 1 FROM public.community_members m
      WHERE m.community_id = v_community_id
        AND m.user_id = p_caller_id
        AND m.role IN ('ORGANIZER', 'MODERATOR')
    )
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_caller_id AND p.is_admin = TRUE)
  ) THEN
    RETURN jsonb_build_object('error', 'Unauthorized: Insufficient permissions to refund this payment');
  END IF;

  -- 2. Global Lock Hierarchy Level 1: Lock Event Row FIRST
  -- Eliminates deadlock hazard with reserve_ticket_capacity and atomic_free_event_registration
  IF v_event_id IS NOT NULL THEN
    PERFORM 1 FROM public.events WHERE id = v_event_id FOR UPDATE;
  END IF;

  -- 3. Global Lock Hierarchy Level 2: Lock Registration Row SECOND
  SELECT r.status INTO v_reg_status
  FROM public.registrations r
  WHERE r.id = v_reg_id
  FOR UPDATE;

  -- Attended guard: attended tickets are permanently non-refundable
  IF v_reg_status = 'attended' THEN
    RETURN jsonb_build_object(
      'error', 'not_refundable_attended',
      'message', 'Attendee already attended the event - no refund'
    );
  END IF;

  IF v_reg_status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'error', 'already_cancelled',
      'message', 'Registration is already cancelled'
    );
  END IF;

  -- 4. Global Lock Hierarchy Level 3: Lock Payment Row THIRD
  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF v_payment.status NOT IN ('success', 'failed') OR v_payment.razorpay_payment_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Payment is not refundable in its current state');
  END IF;

  -- 5. Atomic Cancellation: cancel ticket and clear QR code immediately
  UPDATE public.registrations
  SET status = 'cancelled',
      qr_code = NULL,
      deleted_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = v_reg_id;

  -- Exactly-once capacity decrement (only if prior status was confirmed)
  IF v_reg_status = 'confirmed' AND v_event_id IS NOT NULL THEN
    UPDATE public.events
    SET booked_count = GREATEST(0, booked_count - 1),
        updated_at = clock_timestamp()
    WHERE id = v_event_id;
    v_booked_count_decremented := TRUE;
  END IF;

  -- 6. Acquire refund claim & persist durable recovery debt in same transaction
  UPDATE public.payments
  SET refund_claim_state = 'claimed',
      refund_claim_at = clock_timestamp(),
      refund_attempt_count = COALESCE(refund_attempt_count, 0) + 1,
      refund_reason = 'organizer_issue_refund',
      refund_amount_due = v_payment.amount,
      updated_at = clock_timestamp()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'ok', true,
    'payment_id', p_payment_id,
    'registration_id', v_reg_id,
    'amount', v_payment.amount,
    'razorpay_payment_id', v_payment.razorpay_payment_id,
    'claim_attempt', COALESCE(v_payment.refund_attempt_count, 0) + 1,
    'decremented_capacity', v_booked_count_decremented
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.cancel_registration_and_claim_refund(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_registration_and_claim_refund(UUID, UUID) TO service_role;

-- ----------------------------------------------------------------------------
-- 2. claim_payment_refund(p_payment_id, p_reason, p_amount)
--    Restores attended check with correct lock ordering (Level 2 -> Level 3).
--    Zero deadlock risk and strict defense-in-depth at database level.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_payment_refund(
  p_payment_id UUID,
  p_reason TEXT DEFAULT NULL,
  p_amount INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reg_id UUID;
  v_reg_status TEXT;
  v_payment RECORD;
  v_new_attempt INTEGER;
BEGIN
  -- Step 0: Non-locking lookup to determine foreign key hierarchy
  SELECT p.registration_id INTO v_reg_id
  FROM public.payments p
  WHERE p.id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  -- Level 2: Lock Registration Row FIRST (Global Lock Hierarchy Level 2)
  SELECT r.status INTO v_reg_status
  FROM public.registrations r
  WHERE r.id = v_reg_id
  FOR UPDATE;

  -- Attended guard: attended tickets are permanently non-refundable
  IF v_reg_status = 'attended' THEN
    RETURN jsonb_build_object(
      'error', 'not_refundable_attended',
      'message', 'Attendee already attended the event - no refund'
    );
  END IF;

  -- Level 3: Lock Payment Row SECOND (Global Lock Hierarchy Level 3)
  SELECT p.* INTO v_payment
  FROM public.payments p
  WHERE p.id = p_payment_id
  FOR UPDATE OF p;

  -- Validate payment state
  IF v_payment.status NOT IN ('success', 'failed', 'refunded')
     OR v_payment.razorpay_payment_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Payment is not refundable in its current state');
  END IF;

  -- Terminal states and accepted/queued provider refunds: nothing to do.
  IF v_payment.refund_claim_state = 'issued'
     OR v_payment.refund_status IN ('processed', 'approved', 'requested', 'pending', 'queued') THEN
    RETURN jsonb_build_object(
      'already_refunded', true,
      'refund_status', v_payment.refund_status,
      'razorpay_refund_id', v_payment.razorpay_refund_id
    );
  END IF;

  -- Active claim conflict check (< 15 minutes)
  IF v_payment.refund_claim_state = 'claimed' THEN
    IF v_payment.refund_claim_at IS NOT NULL
       AND v_payment.refund_claim_at > clock_timestamp() - interval '15 minutes' THEN
      RETURN jsonb_build_object('conflict', true, 'refund_claim_at', v_payment.refund_claim_at);
    END IF;
  END IF;

  v_new_attempt := COALESCE(v_payment.refund_attempt_count, 0) + 1;

  -- Fresh claim (or stale reclaim): persist policy inputs once via COALESCE
  UPDATE public.payments
  SET refund_claim_state = 'claimed',
      refund_claim_at = clock_timestamp(),
      refund_attempt_count = v_new_attempt,
      refund_reason = COALESCE(refund_reason, p_reason),
      refund_amount_due = COALESCE(refund_amount_due, p_amount),
      updated_at = clock_timestamp()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'ok', true,
    'attempt', v_new_attempt,
    'stale_reclaimed', (v_payment.refund_claim_state = 'claimed')
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.claim_payment_refund(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_refund(UUID, TEXT, INTEGER) TO service_role;

-- ----------------------------------------------------------------------------
-- 3. cancel_registration_and_decrement(p_registration_id, p_deleted_at)
--    Hardened with Global Lock Hierarchy Level 1 (events) -> Level 2 (registrations)
--    and explicit attended protection to prevent silent cancellation of attended tickets.
-- ----------------------------------------------------------------------------
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
  -- Step 0: Identify event_id non-locking
  SELECT r.event_id INTO v_event_id
  FROM public.registrations r
  WHERE r.id = p_registration_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Level 1: Lock Event Row FIRST
  IF v_event_id IS NOT NULL THEN
    PERFORM 1 FROM public.events WHERE id = v_event_id FOR UPDATE;
  END IF;

  -- Level 2: Lock Registration Row SECOND
  SELECT r.status, r.event_id
  INTO v_prior_status, v_event_id
  FROM public.registrations r
  WHERE r.id = p_registration_id
  FOR UPDATE;

  -- Attended guard: attended registrations MUST NEVER be overwritten to cancelled
  IF v_prior_status = 'attended' THEN
    RETURN FALSE;
  END IF;

  -- Only cancel if not already cancelled
  IF v_prior_status = 'cancelled' THEN
    RETURN FALSE;
  END IF;

  UPDATE public.registrations
  SET status = 'cancelled',
      qr_code = NULL,
      deleted_at = COALESCE(p_deleted_at, clock_timestamp()),
      updated_at = clock_timestamp()
  WHERE id = p_registration_id;

  IF v_prior_status = 'confirmed' AND v_event_id IS NOT NULL THEN
    UPDATE public.events
    SET booked_count = GREATEST(0, booked_count - 1),
        updated_at = clock_timestamp()
    WHERE id = v_event_id;
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.cancel_registration_and_decrement(UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_registration_and_decrement(UUID, TIMESTAMPTZ) TO service_role;

