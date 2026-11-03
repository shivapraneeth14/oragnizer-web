-- ============================================================================
-- CLUVO — Refund policy: ticket-only for confirmed bookings, full for
-- never-confirmed captures, recorded consistently everywhere.
--
-- Rule: refund = COALESCE(payments.organizer_share, payments.amount)
--   * organizer_share IS NOT NULL -> ticket was issued -> refund ticket only,
--     platform fee is kept, organizer wallet is debited by organizer_share.
--   * organizer_share IS NULL     -> no ticket was issued -> refund the full
--     charged amount (fee included), and debit the organizer wallet NOTHING.
--
-- Fixes:
--   1. Event cancellation enqueue stores the refundable amount, not the full
--      charged amount, on refund_task_queue.
--   2. Admin provider-refund adoption and manual settlement record the same
--      amount in payments.refunded_amount, payment_refund_history,
--      payment_audit_log, and the queue row.
--   3. Those admin paths no longer debit an organizer share that was never
--      credited (never-confirmed capture).
--   4. cancel_registration_and_claim_refund persists the same amount in
--      refund_amount_due so retries never re-derive a different number.
--   5. Financial statements stop treating a never-confirmed refunded payment
--      as organizer earnings.
--   6. Open queue rows are backfilled. Completed rows and legacy payment rows
--      are left untouched (historical truth).
-- ============================================================================

-- 1. Event cancellation enqueue: store the refundable amount.
CREATE OR REPLACE FUNCTION public.cancel_event_and_enqueue_refunds(
  p_event_id UUID,
  p_caller_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event RECORD;
  v_community RECORD;
  v_is_authorized BOOLEAN := FALSE;
  v_job_id UUID;
  v_reg RECORD;
  v_payment RECORD;
  v_total_regs INTEGER := 0;
  v_total_refunds INTEGER := 0;
  v_attended_count INTEGER := 0;
BEGIN
  -- 1. Lock the event row immediately
  SELECT * INTO v_event
  FROM public.events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Event not found', 'code', 404);
  END IF;

  IF v_event.status = 'cancelled' THEN
    RETURN jsonb_build_object('error', 'Event is already cancelled', 'code', 400);
  END IF;

  IF v_event.status = 'cancelling' THEN
    SELECT id INTO v_job_id FROM public.event_cancellation_jobs WHERE event_id = p_event_id;
    RETURN jsonb_build_object(
      'status', 'cancelling',
      'job_id', v_job_id,
      'message', 'Event cancellation is already in progress',
      'code', 409
    );
  END IF;

  -- 2. Authorization Verification
  SELECT * INTO v_community FROM public.communities WHERE id = v_event.community_id;
  IF v_community.owner_id = p_caller_id THEN
    v_is_authorized := TRUE;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.community_members
      WHERE community_id = v_event.community_id
        AND user_id = p_caller_id
        AND role IN ('ORGANIZER', 'MODERATOR')
    ) THEN
      v_is_authorized := TRUE;
    ELSE
      IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_caller_id AND is_admin = TRUE) THEN
        v_is_authorized := TRUE;
      END IF;
    END IF;
  END IF;

  IF NOT v_is_authorized THEN
    RETURN jsonb_build_object('error', 'Not authorized to cancel this event', 'code', 403);
  END IF;

  -- 3. Freeze Event Immediately (Blocks all new bookings & payments)
  UPDATE public.events
  SET status = 'cancelling', updated_at = clock_timestamp()
  WHERE id = p_event_id;

  -- 4. Create Master Cancellation Job
  INSERT INTO public.event_cancellation_jobs (
    event_id, initiated_by, status, created_at, updated_at
  ) VALUES (
    p_event_id, p_caller_id, 'pending', clock_timestamp(), clock_timestamp()
  ) RETURNING id INTO v_job_id;

  -- 5. Enqueue Tasks for All Active Registrations
  FOR v_reg IN
    SELECT r.id AS registration_id, r.user_id, r.status AS reg_status
    FROM public.registrations r
    WHERE r.event_id = p_event_id AND r.deleted_at IS NULL
    FOR UPDATE OF r
  LOOP
    v_total_regs := v_total_regs + 1;

    -- Lookup associated payment
    SELECT * INTO v_payment
    FROM public.payments
    WHERE registration_id = v_reg.registration_id
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_reg.reg_status = 'attended' THEN
      -- Attended users keep ticket, no refund issued
      v_attended_count := v_attended_count + 1;
      IF v_payment.id IS NOT NULL THEN
        INSERT INTO public.refund_task_queue (
          job_id, event_id, payment_id, registration_id, amount,
          task_type, status, error_message
        ) VALUES (
          v_job_id, p_event_id, v_payment.id, v_reg.registration_id, COALESCE(v_payment.organizer_share, v_payment.amount),
          'refund', 'skipped_attended', 'Attendee already checked in; refund skipped'
        );
      ELSE
        INSERT INTO public.refund_task_queue (
          job_id, event_id, payment_id, registration_id, amount,
          task_type, status, error_message
        ) VALUES (
          v_job_id, p_event_id, NULL, v_reg.registration_id, 0,
          'cancel_only', 'skipped_attended', 'Attendee already checked in; cancellation skipped'
        );
      END IF;

    ELSIF v_payment.id IS NOT NULL AND v_payment.status = 'success' THEN
      v_total_refunds := v_total_refunds + 1;
      INSERT INTO public.refund_task_queue (
        job_id, event_id, payment_id, registration_id, amount,
        task_type, status
      ) VALUES (
        v_job_id, p_event_id, v_payment.id, v_reg.registration_id, COALESCE(v_payment.organizer_share, v_payment.amount),
        'refund', 'pending'
      );

    ELSIF v_payment.id IS NOT NULL AND v_payment.status = 'pending' AND v_payment.razorpay_order_id IS NOT NULL THEN
      -- In-flight pending payment with provider order; worker will check & refund if captured
      v_total_refunds := v_total_refunds + 1;
      INSERT INTO public.refund_task_queue (
        job_id, event_id, payment_id, registration_id, amount,
        task_type, status
      ) VALUES (
        v_job_id, p_event_id, v_payment.id, v_reg.registration_id, COALESCE(v_payment.organizer_share, v_payment.amount, 0),
        'refund', 'pending'
      );

    ELSIF v_payment.id IS NOT NULL AND (v_payment.status = 'refunded' OR v_payment.refund_claim_state = 'issued') THEN
      -- Already refunded earlier
      INSERT INTO public.refund_task_queue (
        job_id, event_id, payment_id, registration_id, amount,
        task_type, status, error_message
      ) VALUES (
        v_job_id, p_event_id, v_payment.id, v_reg.registration_id, COALESCE(v_payment.organizer_share, v_payment.amount),
        'refund', 'completed', 'Already refunded prior to cancellation'
      );

    ELSE
      -- Free registration or failed payment: release capacity and cancel registration
      INSERT INTO public.refund_task_queue (
        job_id, event_id, payment_id, registration_id, amount,
        task_type, status
      ) VALUES (
        v_job_id, p_event_id, v_payment.id, v_reg.registration_id, 0,
        'cancel_only', 'pending'
      );
    END IF;
  END LOOP;

  -- 6. Update Initial Job Counters
  UPDATE public.event_cancellation_jobs
  SET total_registrations = v_total_regs,
      total_refunds_eligible = v_total_refunds,
      refunds_skipped_attended = v_attended_count,
      updated_at = clock_timestamp()
  WHERE id = v_job_id;

  -- 7. Audit Log Entry
  INSERT INTO public.payment_audit_log (
    action, details
  ) VALUES (
    'event_cancellation_enqueued',
    jsonb_build_object(
      'event_id', p_event_id,
      'job_id', v_job_id,
      'initiated_by', p_caller_id,
      'total_registrations', v_total_regs,
      'total_refunds_eligible', v_total_refunds,
      'skipped_attended', v_attended_count
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'cancelling',
    'job_id', v_job_id,
    'total_registrations', v_total_regs,
    'total_refunds_eligible', v_total_refunds,
    'skipped_attended', v_attended_count
  );
END;
$$;

-- 2. Admin provider-refund adoption: record the refundable amount.
CREATE OR REPLACE FUNCTION public.admin_adopt_provider_refund(
  p_task_id UUID,
  p_admin_id UUID,
  p_razorpay_refund_id TEXT,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_task RECORD;
  v_payment RECORD;
  v_reg RECORD;
  v_event RECORD;
  v_organizer_share INTEGER;
  v_refund_amount INTEGER;
  v_wallet_already_debited BOOLEAN := FALSE;
  v_clean_refund_id TEXT;
BEGIN
  -- 1. Verify admin privilege
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
    RETURN jsonb_build_object('error', 'Unauthorized: Admin privileges required');
  END IF;

  v_clean_refund_id := trim(p_razorpay_refund_id);

  -- 2. Validate refund ID format (Must start with rfnd_ and be >= 10 chars)
  IF v_clean_refund_id IS NULL OR length(v_clean_refund_id) < 10 OR NOT (v_clean_refund_id ~ '^rfnd_[A-Za-z0-9]+$') THEN
    RETURN jsonb_build_object('error', 'Invalid Razorpay Refund ID format (must match rfnd_[A-Za-z0-9]+)');
  END IF;

  -- 3. Lock task row
  SELECT * INTO v_task FROM public.refund_task_queue WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Refund task not found');
  END IF;

  IF v_task.status = 'completed' THEN
    RETURN jsonb_build_object('error', 'Task is already completed');
  END IF;

  IF v_task.payment_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Task has no associated payment');
  END IF;

  -- 4. Cross-Payment Deduplication: verify refund ID is not associated with any OTHER payment
  IF EXISTS (
    SELECT 1 FROM public.payments WHERE razorpay_refund_id = v_clean_refund_id AND id <> v_task.payment_id
    UNION
    SELECT 1 FROM public.payment_refund_history WHERE razorpay_refund_id = v_clean_refund_id AND payment_id <> v_task.payment_id
  ) THEN
    RETURN jsonb_build_object('error', 'Razorpay refund ID is already associated with another payment');
  END IF;

  -- 5. Lock Payment Row FOR UPDATE
  SELECT * INTO v_payment FROM public.payments WHERE id = v_task.payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  -- Refund policy: ticket price when a ticket was issued (organizer_share set),
  -- full charged amount when no ticket was ever issued.
  v_refund_amount := COALESCE(v_payment.organizer_share, v_payment.amount);

  -- 6. Active In-Flight Worker Protection (< 15 minutes)
  IF v_payment.refund_claim_state = 'claimed' THEN
    IF v_payment.refund_claim_at IS NOT NULL
       AND v_payment.refund_claim_at > clock_timestamp() - interval '15 minutes' THEN
      RETURN jsonb_build_object(
        'error', 'Task is currently being processed by an active worker. Please wait before adopting.'
      );
    END IF;
  END IF;

  -- 7. Append-Only Ledger Inspection (Zero Double Debit)
  SELECT EXISTS (
    SELECT 1 FROM public.payment_audit_log
    WHERE payment_id = v_payment.id
      AND action = 'wallet_debited'
  ) INTO v_wallet_already_debited;

  -- 8. Ledger Settlement & Wallet Clawback
  SELECT r.id, r.event_id, r.status INTO v_reg FROM public.registrations r WHERE r.id = v_payment.registration_id;
  IF FOUND THEN
    -- Attended guard: attended tickets are permanently non-refundable
    IF v_reg.status = 'attended' THEN
      RETURN jsonb_build_object(
        'error', 'not_refundable_attended',
        'message', 'Cannot adopt refund: Attendee has already attended the event'
      );
    END IF;

    IF v_reg.event_id IS NOT NULL THEN
      SELECT e.community_id INTO v_event FROM public.events e WHERE e.id = v_reg.event_id;
      IF v_event.community_id IS NOT NULL THEN
        -- Claw back only what the organizer was actually credited.
        -- A never-confirmed capture (organizer_share NULL) credited nothing.
        v_organizer_share := GREATEST(COALESCE(v_payment.organizer_share, 0), 0);

        -- Debit wallet exactly once if not already debited
        IF NOT v_wallet_already_debited AND v_organizer_share > 0 THEN
          PERFORM public.debit_wallet(v_event.community_id, v_organizer_share, 'event_cancellation_manual_adopt', v_reg.event_id);
        END IF;
      END IF;
    END IF;
  END IF;

  -- 9. Persist Payment Refund Truth
  UPDATE public.payments
  SET status = 'refunded',
      refund_status = 'processed',
      razorpay_refund_id = v_clean_refund_id,
      refunded_amount = v_refund_amount,
      refund_amount_due = NULL,
      refund_claim_state = 'issued',
      refund_claim_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = v_payment.id;

  -- 10. Archive into payment_refund_history
  INSERT INTO public.payment_refund_history (
    payment_id, registration_id, event_id, amount, payment_amount, platform_fee,
    refund_status, razorpay_refund_id, refund_reason, created_at
  ) VALUES (
    v_payment.id, v_payment.registration_id, v_task.event_id,
    v_refund_amount, v_payment.amount, v_payment.platform_fee,
    'processed', v_clean_refund_id, 'event_cancellation_manual_adopt', clock_timestamp()
  ) ON CONFLICT (payment_id, razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL
  DO UPDATE SET refund_status = 'processed', updated_at = clock_timestamp();

  -- 11. Cancel registration and decrement capacity
  PERFORM public.cancel_registration_and_decrement(v_task.registration_id, clock_timestamp());

  -- 12. Complete Queue Task
  UPDATE public.refund_task_queue
  SET status = 'completed',
      amount = v_refund_amount,
      razorpay_refund_id = v_clean_refund_id,
      error_message = 'Adopted verified provider refund: ' || COALESCE(p_notes, ''),
      updated_at = clock_timestamp()
  WHERE id = p_task_id;

  -- 13. Update Job Progress
  PERFORM public.update_cancellation_job_progress(v_task.job_id);

  -- 14. Audit Log
  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('admin_adopt_provider_refund', v_payment.id,
    jsonb_build_object(
      'admin_id', p_admin_id,
      'task_id', p_task_id,
      'refund_id', v_clean_refund_id,
      'amount', v_refund_amount,
      'notes', p_notes,
      'wallet_already_debited', v_wallet_already_debited
    ));

  RETURN jsonb_build_object('ok', true, 'task_id', p_task_id, 'refund_id', v_clean_refund_id, 'amount', v_refund_amount);
END;
$$;

-- 3. Admin manual settlement: record the refundable amount.
CREATE OR REPLACE FUNCTION public.admin_manual_settlement(
  p_task_id UUID,
  p_admin_id UUID,
  p_evidence JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_task RECORD;
  v_payment RECORD;
  v_reg RECORD;
  v_event RECORD;
  v_organizer_share INTEGER;
  v_refund_amount INTEGER;
  v_wallet_already_debited BOOLEAN := FALSE;
  v_settle_id TEXT;
  v_method TEXT;
  v_ref TEXT;
  v_notes TEXT;
BEGIN
  -- 1. Verify admin privilege
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
    RETURN jsonb_build_object('error', 'Unauthorized: Admin privileges required');
  END IF;

  -- 2. Validate structured evidence inputs
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
    RETURN jsonb_build_object('error', 'Structured settlement evidence object is required');
  END IF;

  v_method := p_evidence->>'settlement_method';
  v_ref := trim(COALESCE(p_evidence->>'reference_number', ''));
  v_notes := trim(COALESCE(p_evidence->>'notes', ''));

  IF v_method IS NULL OR v_method NOT IN ('bank_transfer', 'upi', 'cash', 'cheque', 'dispute_resolution') THEN
    RETURN jsonb_build_object('error', 'Invalid settlement_method (must be bank_transfer, upi, cash, cheque, or dispute_resolution)');
  END IF;

  IF length(v_ref) < 10 OR NOT (v_ref ~ '^[A-Za-z0-9_-]+$') THEN
    RETURN jsonb_build_object('error', 'Invalid reference_number (must be at least 10 alphanumeric characters)');
  END IF;

  IF length(v_notes) < 20 THEN
    RETURN jsonb_build_object('error', 'Detailed settlement notes required (minimum 20 characters)');
  END IF;

  -- 3. Lock task row
  SELECT * INTO v_task FROM public.refund_task_queue WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Refund task not found');
  END IF;

  IF v_task.status = 'completed' THEN
    RETURN jsonb_build_object('error', 'Task is already completed');
  END IF;

  IF v_task.payment_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Task has no associated payment');
  END IF;

  -- 4. Global Reference Uniqueness: ensure reference has never been used in any settlement
  IF EXISTS (
    SELECT 1 FROM public.payment_audit_log
    WHERE action = 'offline_manual_settlement'
      AND details->'evidence'->>'reference_number' = v_ref
  ) THEN
    RETURN jsonb_build_object('error', 'Reference number has already been used for another offline settlement');
  END IF;

  -- 5. Lock Payment Row
  SELECT * INTO v_payment FROM public.payments WHERE id = v_task.payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  -- Refund policy: ticket price when a ticket was issued (organizer_share set),
  -- full charged amount when no ticket was ever issued.
  v_refund_amount := COALESCE(v_payment.organizer_share, v_payment.amount);

  v_settle_id := 'manual_settle_' || v_task.id;

  -- 6. Append-Only Ledger Inspection (Zero Double Debit)
  SELECT EXISTS (
    SELECT 1 FROM public.payment_audit_log
    WHERE payment_id = v_payment.id
      AND action = 'wallet_debited'
  ) INTO v_wallet_already_debited;

  -- 7. Attended Guard & Debit organizer wallet if not already debited
  SELECT r.id, r.event_id, r.status INTO v_reg FROM public.registrations r WHERE r.id = v_payment.registration_id;
  IF FOUND THEN
    -- Attended guard: attended tickets are permanently non-refundable
    IF v_reg.status = 'attended' THEN
      RETURN jsonb_build_object(
        'error', 'not_refundable_attended',
        'message', 'Cannot manually settle refund: Attendee has already attended the event'
      );
    END IF;

    IF v_reg.event_id IS NOT NULL THEN
      SELECT e.community_id INTO v_event FROM public.events e WHERE e.id = v_reg.event_id;
      IF v_event.community_id IS NOT NULL THEN
        -- Claw back only what the organizer was actually credited.
        -- A never-confirmed capture (organizer_share NULL) credited nothing.
        v_organizer_share := GREATEST(COALESCE(v_payment.organizer_share, 0), 0);

        IF NOT v_wallet_already_debited AND v_organizer_share > 0 THEN
          PERFORM public.debit_wallet(v_event.community_id, v_organizer_share, 'offline_manual_settlement', v_reg.event_id);
        END IF;
      END IF;
    END IF;
  END IF;

  -- 8. Persist Payment Refund Truth
  UPDATE public.payments
  SET status = 'refunded',
      refund_status = 'processed',
      razorpay_refund_id = v_settle_id,
      refunded_amount = v_refund_amount,
      refund_amount_due = NULL,
      refund_claim_state = 'issued',
      refund_claim_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = v_payment.id;

  -- 9. Archive into payment_refund_history
  INSERT INTO public.payment_refund_history (
    payment_id, registration_id, event_id, amount, payment_amount, platform_fee,
    refund_status, razorpay_refund_id, refund_reason, created_at
  ) VALUES (
    v_payment.id, v_payment.registration_id, v_task.event_id,
    v_refund_amount, v_payment.amount, v_payment.platform_fee,
    'processed', v_settle_id, 'offline_manual_settlement', clock_timestamp()
  ) ON CONFLICT (payment_id, razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL
  DO NOTHING;

  -- 10. Cancel registration & decrement capacity
  PERFORM public.cancel_registration_and_decrement(v_task.registration_id, clock_timestamp());

  -- 11. Complete Queue Task
  UPDATE public.refund_task_queue
  SET status = 'completed',
      amount = v_refund_amount,
      razorpay_refund_id = v_settle_id,
      error_message = 'Manually settled offline: ' || v_ref || ' (' || v_method || ')',
      updated_at = clock_timestamp()
  WHERE id = p_task_id;

  -- 12. Update Job Progress
  PERFORM public.update_cancellation_job_progress(v_task.job_id);

  -- 13. Audit Log with Full Structured Evidence
  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('offline_manual_settlement', v_payment.id,
    jsonb_build_object(
      'admin_id', p_admin_id,
      'task_id', p_task_id,
      'settle_id', v_settle_id,
      'amount', v_refund_amount,
      'evidence', p_evidence,
      'wallet_already_debited', v_wallet_already_debited
    ));

  RETURN jsonb_build_object('ok', true, 'task_id', p_task_id, 'settle_id', v_settle_id, 'amount', v_refund_amount);
END;
$$;

-- 4. Organizer claim: persist the same refundable amount for retries.
CREATE OR REPLACE FUNCTION public.cancel_registration_and_claim_refund(p_payment_id uuid, p_caller_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      refund_amount_due = COALESCE(v_payment.organizer_share, v_payment.amount),
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
$function$;

-- 5. Statements: never count a never-confirmed capture as earnings.
CREATE OR REPLACE FUNCTION public.get_admin_financial_statement(p_community_id uuid, p_event_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can view the full financial ledger.';
  END IF;

  WITH deduped_prh AS (
    SELECT DISTINCT ON (COALESCE(prh.razorpay_refund_id, prh.id::TEXT))
      prh.*
    FROM public.payment_refund_history prh
    ORDER BY COALESCE(prh.razorpay_refund_id, prh.id::TEXT), prh.created_at DESC
  ),
  calculated_refunds AS (
    SELECT
      d.created_at,
      d.id AS transaction_id,
      'refund'::TEXT AS transaction_type,
      COALESCE(d.refund_status, 'processed') AS status,
      ('Refund: ' || COALESCE(d.refund_reason, 'Ticket cancelled'))::TEXT AS description,
      d.razorpay_refund_id AS reference_id,
      d.payment_id::TEXT AS secondary_ref,
      COALESCE(
        NULLIF(TRIM(COALESCE(prof.first_name, '') || ' ' || COALESCE(prof.last_name, '')), ''),
        NULLIF(prof.username, ''),
        prof.email,
        'Attendee'
      ) AS attendee_name,
      prof.email AS attendee_email,
      NULL::TEXT AS attendee_phone,
      r.id AS registration_id,
      d.event_id AS event_id,
      e.title AS event_title,
      'Refunded'::TEXT AS check_in_status,
      COALESCE(d.payment_amount, p.amount, d.amount) AS gross_amount,
      COALESCE(d.platform_fee, 0) AS platform_fee,
      GREATEST(0, LEAST(
        d.amount,
        COALESCE(p.organizer_share, 0)
        - COALESCE(SUM(
            d.amount
          ) OVER (
            PARTITION BY d.payment_id
            ORDER BY d.created_at, d.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::INTEGER AS organizer_share,
      0::INTEGER AS money_in,
      GREATEST(0, LEAST(
        d.amount,
        COALESCE(p.organizer_share, 0)
        - COALESCE(SUM(
            d.amount
          ) OVER (
            PARTITION BY d.payment_id
            ORDER BY d.created_at, d.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::INTEGER AS money_out,
      d.refund_reason AS refund_reason,
      NULL::TEXT AS admin_notes,
      'razorpay'::TEXT AS payment_method,
      NULL::JSONB AS bank_details,
      NULL::TIMESTAMPTZ AS confirmed_at,
      NULL::TEXT AS resolution_notes,
      NULL::TIMESTAMPTZ AS resolved_at
    FROM deduped_prh d
    JOIN public.registrations r ON r.id = d.registration_id
    JOIN public.events e ON e.id = d.event_id
    LEFT JOIN public.payments p ON p.id = d.payment_id
    LEFT JOIN public.profiles prof ON prof.id = r.user_id
    WHERE e.community_id = p_community_id
      AND (p_event_id IS NULL OR d.event_id = p_event_id)
      AND (
        p.status = 'refunded'
        OR EXISTS (
          SELECT 1 FROM public.payment_audit_log pal
          WHERE pal.action = 'wallet_debited'
            AND (pal.details->>'community_id')::UUID = p_community_id
            AND ((pal.details->>'event_id')::UUID = d.event_id OR pal.payment_id = d.payment_id)
        )
      )
  ),
  raw_transactions AS (
    -- Flow 1: Confirmed Ticket Sales (payments)
    SELECT
      p.created_at,
      p.id AS transaction_id,
      'ticket_sale'::TEXT AS transaction_type,
      p.status AS status,
      'Ticket Purchase'::TEXT AS description,
      p.razorpay_payment_id AS reference_id,
      p.razorpay_order_id AS secondary_ref,
      COALESCE(
        NULLIF(TRIM(COALESCE(prof.first_name, '') || ' ' || COALESCE(prof.last_name, '')), ''),
        NULLIF(prof.username, ''),
        prof.email,
        'Attendee'
      ) AS attendee_name,
      prof.email AS attendee_email,
      NULL::TEXT AS attendee_phone,
      r.id AS registration_id,
      r.event_id AS event_id,
      e.title AS event_title,
      CASE
        WHEN r.checked_in THEN 'Attended'
        WHEN r.status = 'cancelled' THEN 'Cancelled'
        ELSE 'Confirmed'
      END AS check_in_status,
      p.amount AS gross_amount,
      COALESCE(p.platform_fee, 0) AS platform_fee,
      COALESCE(p.organizer_share, 0) AS organizer_share,
      COALESCE(p.organizer_share, 0) AS money_in,
      0::INTEGER AS money_out,
      NULL::TEXT AS refund_reason,
      NULL::TEXT AS admin_notes,
      'razorpay'::TEXT AS payment_method,
      NULL::JSONB AS bank_details,
      NULL::TIMESTAMPTZ AS confirmed_at,
      NULL::TEXT AS resolution_notes,
      NULL::TIMESTAMPTZ AS resolved_at
    FROM public.payments p
    JOIN public.registrations r ON r.id = p.registration_id
    JOIN public.events e ON e.id = r.event_id
    LEFT JOIN public.profiles prof ON prof.id = r.user_id
    WHERE e.community_id = p_community_id
      AND (p_event_id IS NULL OR r.event_id = p_event_id)
      AND (
        (p.status = 'success' AND r.status IN ('confirmed', 'attended'))
        OR p.status = 'refunded'
      )

    UNION ALL

    -- Flow 2: Verified Customer Refunds
    SELECT * FROM calculated_refunds

    UNION ALL

    -- Flow 3: Manual Payouts & Transfers
    SELECT
      pi.created_at,
      pi.id AS transaction_id,
      CASE
        WHEN pi.status = 'success' THEN 'payout_confirmed'
        WHEN pi.status = 'disputed' THEN 'payout_disputed'
        WHEN pi.status = 'cancelled' THEN 'payout_cancelled'
        ELSE 'payout_pending'
      END::TEXT AS transaction_type,
      pi.status AS status,
      ('Payout → ' || COALESCE(cb.label, cb.account_holder, 'Bank Transfer'))::TEXT AS description,
      pi.utr AS reference_id,
      pi.id::TEXT AS secondary_ref,
      COALESCE(cb.account_holder, 'Beneficiary') AS attendee_name,
      NULL::TEXT AS attendee_email,
      NULL::TEXT AS attendee_phone,
      NULL::UUID AS registration_id,
      pi.event_id AS event_id,
      e.title AS event_title,
      pi.status AS check_in_status,
      pi.amount AS gross_amount,
      0::INTEGER AS platform_fee,
      pi.amount AS organizer_share,
      0::INTEGER AS money_in,
      pi.amount AS money_out,
      pi.dispute_reason AS refund_reason,
      pi.admin_notes AS admin_notes,
      COALESCE(pi.payment_method, 'bank_transfer') AS payment_method,
      CASE WHEN cb.id IS NOT NULL THEN
        jsonb_build_object(
          'account_holder', cb.account_holder,
          'bank_account_number', cb.bank_account_number,
          'bank_ifsc', cb.bank_ifsc,
          'label', cb.label
        )
      ELSE NULL END AS bank_details,
      pi.confirmed_at AS confirmed_at,
      pi.resolution_notes AS resolution_notes,
      pi.resolved_at AS resolved_at
    FROM public.payout_items pi
    LEFT JOIN public.community_beneficiaries cb ON cb.id = pi.beneficiary_id
    LEFT JOIN public.events e ON e.id = pi.event_id
    WHERE pi.community_id = p_community_id
      AND (p_event_id IS NULL OR pi.event_id = p_event_id)
  ),
  with_running_balance AS (
    SELECT
      rt.*,
      SUM(
        rt.money_in - CASE
          WHEN rt.transaction_type = 'refund' OR rt.status IN ('success', 'processed') THEN rt.money_out
          ELSE 0
        END
      ) OVER (ORDER BY rt.created_at ASC) AS running_balance
    FROM raw_transactions rt
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'transaction_id', w.transaction_id,
      'created_at', w.created_at,
      'transaction_type', w.transaction_type,
      'status', w.status,
      'description', w.description,
      'reference_id', w.reference_id,
      'secondary_ref', w.secondary_ref,
      'attendee_name', w.attendee_name,
      'attendee_email', w.attendee_email,
      'attendee_phone', w.attendee_phone,
      'registration_id', w.registration_id,
      'event_id', w.event_id,
      'event_title', w.event_title,
      'check_in_status', w.check_in_status,
      'gross_amount', w.gross_amount,
      'platform_fee', w.platform_fee,
      'organizer_share', w.organizer_share,
      'money_in', w.money_in,
      'money_out', w.money_out,
      'running_balance', w.running_balance,
      'refund_reason', w.refund_reason,
      'admin_notes', w.admin_notes,
      'payment_method', w.payment_method,
      'bank_details', w.bank_details,
      'confirmed_at', w.confirmed_at,
      'resolution_notes', w.resolution_notes,
      'resolved_at', w.resolved_at
    )
    ORDER BY w.created_at DESC
  ) INTO v_result
  FROM with_running_balance w;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_organizer_financial_statement(p_community_id uuid, p_event_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT (public.is_community_owner(p_community_id) OR public.is_community_team(p_community_id) OR public.is_admin_user()) THEN
    RAISE EXCEPTION 'Unauthorized: Only community organizers and team can view community financials.';
  END IF;

  WITH deduped_prh AS (
    SELECT DISTINCT ON (COALESCE(prh.razorpay_refund_id, prh.id::TEXT))
      prh.*
    FROM public.payment_refund_history prh
    ORDER BY COALESCE(prh.razorpay_refund_id, prh.id::TEXT), prh.created_at DESC
  ),
  calculated_refunds AS (
    SELECT
      d.created_at,
      d.id AS transaction_id,
      'refund'::TEXT AS transaction_type,
      COALESCE(d.refund_status, 'processed') AS status,
      ('Refund: ' || COALESCE(d.refund_reason, 'Ticket cancelled'))::TEXT AS description,
      d.razorpay_refund_id AS reference_id,
      d.payment_id::TEXT AS secondary_ref,
      COALESCE(
        NULLIF(TRIM(COALESCE(prof.first_name, '') || ' ' || COALESCE(prof.last_name, '')), ''),
        NULLIF(prof.username, ''),
        prof.email,
        'Attendee'
      ) AS attendee_name,
      prof.email AS attendee_email,
      NULL::TEXT AS attendee_phone,
      r.id AS registration_id,
      d.event_id AS event_id,
      e.title AS event_title,
      'Refunded'::TEXT AS check_in_status,
      COALESCE(d.payment_amount, p.amount, d.amount) AS gross_amount,
      COALESCE(d.platform_fee, 0) AS platform_fee,
      GREATEST(0, LEAST(
        d.amount,
        COALESCE(p.organizer_share, 0)
        - COALESCE(SUM(
            d.amount
          ) OVER (
            PARTITION BY d.payment_id
            ORDER BY d.created_at, d.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::INTEGER AS organizer_share,
      0::INTEGER AS money_in,
      GREATEST(0, LEAST(
        d.amount,
        COALESCE(p.organizer_share, 0)
        - COALESCE(SUM(
            d.amount
          ) OVER (
            PARTITION BY d.payment_id
            ORDER BY d.created_at, d.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::INTEGER AS money_out,
      d.refund_reason AS refund_reason,
      NULL::TEXT AS admin_notes,
      'razorpay'::TEXT AS payment_method,
      NULL::JSONB AS bank_details,
      NULL::TIMESTAMPTZ AS confirmed_at,
      NULL::TEXT AS resolution_notes,
      NULL::TIMESTAMPTZ AS resolved_at
    FROM deduped_prh d
    JOIN public.registrations r ON r.id = d.registration_id
    JOIN public.events e ON e.id = d.event_id
    LEFT JOIN public.payments p ON p.id = d.payment_id
    LEFT JOIN public.profiles prof ON prof.id = r.user_id
    WHERE e.community_id = p_community_id
      AND (p_event_id IS NULL OR d.event_id = p_event_id)
      AND (
        p.status = 'refunded'
        OR EXISTS (
          SELECT 1 FROM public.payment_audit_log pal
          WHERE pal.action = 'wallet_debited'
            AND (pal.details->>'community_id')::UUID = p_community_id
            AND ((pal.details->>'event_id')::UUID = d.event_id OR pal.payment_id = d.payment_id)
        )
      )
  ),
  raw_transactions AS (
    -- Flow 1: Confirmed Ticket Sales (payments)
    SELECT
      p.created_at,
      p.id AS transaction_id,
      'ticket_sale'::TEXT AS transaction_type,
      p.status AS status,
      'Ticket Purchase'::TEXT AS description,
      p.razorpay_payment_id AS reference_id,
      p.razorpay_order_id AS secondary_ref,
      COALESCE(
        NULLIF(TRIM(COALESCE(prof.first_name, '') || ' ' || COALESCE(prof.last_name, '')), ''),
        NULLIF(prof.username, ''),
        prof.email,
        'Attendee'
      ) AS attendee_name,
      prof.email AS attendee_email,
      NULL::TEXT AS attendee_phone,
      r.id AS registration_id,
      r.event_id AS event_id,
      e.title AS event_title,
      CASE
        WHEN r.checked_in THEN 'Attended'
        WHEN r.status = 'cancelled' THEN 'Cancelled'
        ELSE 'Confirmed'
      END AS check_in_status,
      p.amount AS gross_amount,
      COALESCE(p.platform_fee, 0) AS platform_fee,
      COALESCE(p.organizer_share, 0) AS organizer_share,
      COALESCE(p.organizer_share, 0) AS money_in,
      0::INTEGER AS money_out,
      NULL::TEXT AS refund_reason,
      NULL::TEXT AS admin_notes,
      'razorpay'::TEXT AS payment_method,
      NULL::JSONB AS bank_details,
      NULL::TIMESTAMPTZ AS confirmed_at,
      NULL::TEXT AS resolution_notes,
      NULL::TIMESTAMPTZ AS resolved_at
    FROM public.payments p
    JOIN public.registrations r ON r.id = p.registration_id
    JOIN public.events e ON e.id = r.event_id
    LEFT JOIN public.profiles prof ON prof.id = r.user_id
    WHERE e.community_id = p_community_id
      AND (p_event_id IS NULL OR r.event_id = p_event_id)
      AND (
        (p.status = 'success' AND r.status IN ('confirmed', 'attended'))
        OR p.status = 'refunded'
      )

    UNION ALL

    -- Flow 2: Verified Customer Refunds
    SELECT * FROM calculated_refunds

    UNION ALL

    -- Flow 3: Manual Payouts & Transfers
    SELECT
      pi.created_at,
      pi.id AS transaction_id,
      CASE
        WHEN pi.status = 'success' THEN 'payout_confirmed'
        WHEN pi.status = 'disputed' THEN 'payout_disputed'
        WHEN pi.status = 'cancelled' THEN 'payout_cancelled'
        ELSE 'payout_pending'
      END::TEXT AS transaction_type,
      pi.status AS status,
      ('Payout → ' || COALESCE(cb.label, cb.account_holder, 'Settlement'))::TEXT AS description,
      pi.utr AS reference_id,
      pi.id::TEXT AS secondary_ref,
      COALESCE(cb.account_holder, 'Beneficiary') AS attendee_name,
      NULL::TEXT AS attendee_email,
      NULL::TEXT AS attendee_phone,
      NULL::UUID AS registration_id,
      pi.event_id AS event_id,
      e.title AS event_title,
      pi.status AS check_in_status,
      pi.amount AS gross_amount,
      0::INTEGER AS platform_fee,
      pi.amount AS organizer_share,
      0::INTEGER AS money_in,
      pi.amount AS money_out,
      pi.dispute_reason AS refund_reason,
      pi.admin_notes AS admin_notes,
      COALESCE(pi.payment_method, 'bank_transfer') AS payment_method,
      CASE WHEN cb.id IS NOT NULL THEN
        jsonb_build_object(
          'account_holder', cb.account_holder,
          'bank_account_number', cb.bank_account_number,
          'bank_ifsc', cb.bank_ifsc,
          'label', cb.label
        )
      ELSE NULL END AS bank_details,
      pi.confirmed_at AS confirmed_at,
      pi.resolution_notes AS resolution_notes,
      pi.resolved_at AS resolved_at
    FROM public.payout_items pi
    LEFT JOIN public.community_beneficiaries cb ON cb.id = pi.beneficiary_id
    LEFT JOIN public.events e ON e.id = pi.event_id
    WHERE pi.community_id = p_community_id
      AND (p_event_id IS NULL OR pi.event_id = p_event_id)
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'created_at', t.created_at,
      'transaction_id', t.transaction_id,
      'transaction_type', t.transaction_type,
      'status', t.status,
      'description', t.description,
      'reference_id', t.reference_id,
      'secondary_ref', t.secondary_ref,
      'attendee_name', t.attendee_name,
      'attendee_email', t.attendee_email,
      'attendee_phone', t.attendee_phone,
      'registration_id', t.registration_id,
      'event_id', t.event_id,
      'event_title', t.event_title,
      'check_in_status', t.check_in_status,
      'gross_amount', t.gross_amount,
      'platform_fee', t.platform_fee,
      'organizer_share', t.organizer_share,
      'money_in', t.money_in,
      'money_out', t.money_out,
      'refund_reason', t.refund_reason,
      'admin_notes', t.admin_notes,
      'payment_method', t.payment_method,
      'bank_details', t.bank_details,
      'confirmed_at', t.confirmed_at,
      'resolution_notes', t.resolution_notes,
      'resolved_at', t.resolved_at
    )
    ORDER BY t.created_at DESC
  ), '[]'::JSONB)
  INTO v_result
  FROM raw_transactions t;

  RETURN v_result;
END;
$function$;


REVOKE ALL PRIVILEGES ON FUNCTION public.cancel_event_and_enqueue_refunds(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_event_and_enqueue_refunds(uuid, uuid)
  TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_adopt_provider_refund(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adopt_provider_refund(UUID, UUID, TEXT, TEXT)
  TO authenticated, service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_manual_settlement(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_manual_settlement(UUID, UUID, JSONB)
  TO authenticated, service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.cancel_registration_and_claim_refund(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_registration_and_claim_refund(UUID, UUID)
  TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_admin_financial_statement(UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_financial_statement(UUID, UUID)
  TO authenticated, service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_organizer_financial_statement(UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_organizer_financial_statement(UUID, UUID)
  TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Backfill only OPEN queue tasks. Completed/skipped rows are history and are
-- deliberately left as they were. Legacy payment rows are never rewritten.
-- ----------------------------------------------------------------------------
UPDATE public.refund_task_queue t
SET amount = COALESCE(p.organizer_share, p.amount),
    updated_at = clock_timestamp()
FROM public.payments p
WHERE p.id = t.payment_id
  AND t.task_type = 'refund'
  AND t.status IN ('pending', 'processing', 'failed', 'uncertain', 'manual_review')
  AND t.amount IS DISTINCT FROM COALESCE(p.organizer_share, p.amount);
