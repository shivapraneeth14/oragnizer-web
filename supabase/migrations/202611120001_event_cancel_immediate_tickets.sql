-- ============================================================================
-- CLUVO — Event cancellation: cancel tickets immediately + auto-finalize
--
-- Problem this fixes:
--   1. Non-attended tickets stayed `confirmed` until their refund succeeded, so
--      a customer saw a valid-looking ticket for a cancelled event.
--   2. When an event had nothing to refund (all attendees, zero registrations,
--      or free-only tickets) the worker had no claimable task, so the job was
--      never finalized and the event stayed stuck in `cancelling` forever.
--
-- Strategy (Option A):
--   * Freeze the event as before.
--   * Immediately cancel every NON-ATTENDED registration (the attended guard
--     inside cancel_registration_and_decrement keeps attendees untouched).
--   * Free/failed `cancel_only` tasks are recorded as already completed.
--   * Notify all active participants at enqueue time. The legacy
--     notify_event_cancelled trigger only selects `confirmed` rows, but by the
--     time the event flips to `cancelled` those rows are already `cancelled`
--     (or soft-deleted), so it notified nobody. Emitting here — before the
--     rows are touched — fixes that, and the trigger then finds nothing to
--     duplicate.
--   * Call update_cancellation_job_progress at the end so cancellations with
--     no claimable work finalize instantly.
--
-- Nothing else changes: the refund queue, worker, wallet and claim machine are
-- untouched. The signature is unchanged and privileges are re-asserted.
-- ============================================================================

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
  v_event_status TEXT;
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
      -- Free registration or failed payment: the registration is cancelled
      -- immediately below, so the cleanup task is already done.
      INSERT INTO public.refund_task_queue (
        job_id, event_id, payment_id, registration_id, amount,
        task_type, status, error_message
      ) VALUES (
        v_job_id, p_event_id, v_payment.id, v_reg.registration_id, 0,
        'cancel_only', 'completed', 'Cancelled at event cancellation'
      );
    END IF;
  END LOOP;

  -- 5b. Notify every active participant BEFORE the rows are cancelled/deleted.
  --     Deduped so a retried call cannot double-notify.
  INSERT INTO public.notifications (user_id, type, title, body, payload)
  SELECT r.user_id, 'event_cancelled', 'Event cancelled',
         'The event "' || v_event.title || '" has been cancelled.',
         jsonb_build_object('type', 'event', 'id', p_event_id)
  FROM public.registrations r
  WHERE r.event_id = p_event_id
    AND r.deleted_at IS NULL
    AND r.user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.user_id = r.user_id
        AND n.type = 'event_cancelled'
        AND n.payload->>'id' = p_event_id::TEXT
    );

  -- 5c. Cancel every non-attended ticket immediately (Option A).
  --     cancel_registration_and_decrement is idempotent and refuses to touch
  --     `attended` registrations, so this is safe to run before the refunds.
  FOR v_reg IN
    SELECT r.id AS registration_id
    FROM public.registrations r
    WHERE r.event_id = p_event_id
      AND r.deleted_at IS NULL
      AND r.status <> 'attended'
  LOOP
    PERFORM public.cancel_registration_and_decrement(v_reg.registration_id, clock_timestamp());
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

  -- 8. Finalize immediately when no work remains (all-attended / zero
  --    registrations / free-only). With pending refunds this is a no-op that
  --    just refreshes the job counters and leaves the event in `cancelling`.
  PERFORM public.update_cancellation_job_progress(v_job_id);

  SELECT status INTO v_event_status FROM public.events WHERE id = p_event_id;

  RETURN jsonb_build_object(
    'ok', true,
    'status', v_event_status,
    'job_id', v_job_id,
    'total_registrations', v_total_regs,
    'total_refunds_eligible', v_total_refunds,
    'skipped_attended', v_attended_count
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.cancel_event_and_enqueue_refunds(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_event_and_enqueue_refunds(uuid, uuid)
  TO service_role;
