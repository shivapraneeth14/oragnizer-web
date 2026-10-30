-- ============================================================================
-- CLUVO — STAGE 5 MILESTONE B: DURABLE CANCELLATION & REFUND QUEUE ENGINE
--
-- Replaces synchronous event cancellation loops with an asynchronous, durable,
-- lease-based queue capable of safely processing events with 1,000+ attendees.
-- ============================================================================

-- 1. Extend events status check constraint to include 'cancelling'
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE public.events ADD CONSTRAINT events_status_check 
  CHECK (status IN ('draft', 'published', 'cancelling', 'cancelled', 'completed'));

-- 2. Master Cancellation Job Table
CREATE TABLE IF NOT EXISTS public.event_cancellation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  initiated_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'processing', 'completed', 'requires_manual_review')),
  total_registrations INTEGER NOT NULL DEFAULT 0,
  total_refunds_eligible INTEGER NOT NULL DEFAULT 0,
  refunds_succeeded INTEGER NOT NULL DEFAULT 0,
  refunds_failed INTEGER NOT NULL DEFAULT 0,
  refunds_uncertain INTEGER NOT NULL DEFAULT 0,
  refunds_skipped_attended INTEGER NOT NULL DEFAULT 0,
  registrations_cancelled INTEGER NOT NULL DEFAULT 0,
  error_summary JSONB DEFAULT NULL,
  started_at TIMESTAMPTZ DEFAULT NULL,
  completed_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_event_cancellation_active UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS idx_cancellation_jobs_status 
  ON public.event_cancellation_jobs (status) 
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_cancellation_jobs_event 
  ON public.event_cancellation_jobs (event_id);

-- 3. Granular Refund Task Queue Table
CREATE TABLE IF NOT EXISTS public.refund_task_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.event_cancellation_jobs(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  payment_id UUID REFERENCES public.payments(id) ON DELETE RESTRICT,
  registration_id UUID NOT NULL REFERENCES public.registrations(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL DEFAULT 0, -- In paise (0 for free registration cleanups)
  task_type TEXT NOT NULL DEFAULT 'refund' 
    CHECK (task_type IN ('refund', 'cancel_only')),
  status TEXT NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'uncertain', 'manual_review', 'skipped_attended')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  leased_at TIMESTAMPTZ DEFAULT NULL,
  leased_by TEXT DEFAULT NULL,
  lease_expires_at TIMESTAMPTZ DEFAULT NULL,
  error_message TEXT DEFAULT NULL,
  error_details JSONB DEFAULT NULL,
  razorpay_refund_id TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_refund_task_registration UNIQUE (registration_id)
);

-- Partial unique index allowing multiple free registrations where payment_id IS NULL
CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_task_payment 
  ON public.refund_task_queue (payment_id) 
  WHERE payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_refund_task_queue_claim 
  ON public.refund_task_queue (next_attempt_at, id) 
  WHERE status IN ('pending', 'failed', 'uncertain', 'processing');

CREATE INDEX IF NOT EXISTS idx_refund_task_queue_job 
  ON public.refund_task_queue (job_id, status);

-- 4. Enable Row Level Security
ALTER TABLE public.event_cancellation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refund_task_queue ENABLE ROW LEVEL SECURITY;

-- Organizers and admins can read cancellation jobs for their communities
DROP POLICY IF EXISTS cancellation_jobs_team_read ON public.event_cancellation_jobs;
CREATE POLICY cancellation_jobs_team_read ON public.event_cancellation_jobs
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.events e
    JOIN public.communities c ON c.id = e.community_id
    WHERE e.id = event_cancellation_jobs.event_id
      AND (
        c.owner_id = (SELECT auth.uid())
        OR EXISTS (
          SELECT 1 FROM public.community_members m
          WHERE m.community_id = c.id
            AND m.user_id = (SELECT auth.uid())
            AND m.role IN ('ORGANIZER', 'MODERATOR')
        )
      )
  )
  OR (SELECT is_admin FROM public.profiles WHERE id = (SELECT auth.uid())) = TRUE
);

-- Organizers and admins can read tasks for their communities
DROP POLICY IF EXISTS refund_task_queue_team_read ON public.refund_task_queue;
CREATE POLICY refund_task_queue_team_read ON public.refund_task_queue
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.events e
    JOIN public.communities c ON c.id = e.community_id
    WHERE e.id = refund_task_queue.event_id
      AND (
        c.owner_id = (SELECT auth.uid())
        OR EXISTS (
          SELECT 1 FROM public.community_members m
          WHERE m.community_id = c.id
            AND m.user_id = (SELECT auth.uid())
            AND m.role IN ('ORGANIZER', 'MODERATOR')
        )
      )
  )
  OR (SELECT is_admin FROM public.profiles WHERE id = (SELECT auth.uid())) = TRUE
);

-- Service role has full access
DROP POLICY IF EXISTS cancellation_jobs_service_all ON public.event_cancellation_jobs;
CREATE POLICY cancellation_jobs_service_all ON public.event_cancellation_jobs
FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS refund_task_queue_service_all ON public.refund_task_queue;
CREATE POLICY refund_task_queue_service_all ON public.refund_task_queue
FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. Atomic Cancellation & Enqueue RPC
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
          v_job_id, p_event_id, v_payment.id, v_reg.registration_id, v_payment.amount,
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
        v_job_id, p_event_id, v_payment.id, v_reg.registration_id, v_payment.amount,
        'refund', 'pending'
      );

    ELSIF v_payment.id IS NOT NULL AND v_payment.status = 'pending' AND v_payment.razorpay_order_id IS NOT NULL THEN
      -- In-flight pending payment with provider order; worker will check & refund if captured
      v_total_refunds := v_total_refunds + 1;
      INSERT INTO public.refund_task_queue (
        job_id, event_id, payment_id, registration_id, amount,
        task_type, status
      ) VALUES (
        v_job_id, p_event_id, v_payment.id, v_reg.registration_id, COALESCE(v_payment.amount, 0),
        'refund', 'pending'
      );

    ELSIF v_payment.id IS NOT NULL AND (v_payment.status = 'refunded' OR v_payment.refund_claim_state = 'issued') THEN
      -- Already refunded earlier
      INSERT INTO public.refund_task_queue (
        job_id, event_id, payment_id, registration_id, amount,
        task_type, status, error_message
      ) VALUES (
        v_job_id, p_event_id, v_payment.id, v_reg.registration_id, v_payment.amount,
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

REVOKE ALL PRIVILEGES ON FUNCTION public.cancel_event_and_enqueue_refunds(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_event_and_enqueue_refunds(UUID, UUID) TO service_role;

-- 6. Atomic Batch Task Claiming RPC
CREATE OR REPLACE FUNCTION public.claim_refund_tasks(
  p_batch_size INTEGER,
  p_worker_id TEXT,
  p_lease_seconds INTEGER DEFAULT 60
)
RETURNS SETOF public.refund_task_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lease_expiry TIMESTAMPTZ := clock_timestamp() + (p_lease_seconds || ' seconds')::interval;
BEGIN
  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM public.refund_task_queue
    WHERE (
      -- 1. Ready tasks (fresh, retry after backoff, or uncertain after quiet period)
      (status IN ('pending', 'failed', 'uncertain') AND next_attempt_at <= clock_timestamp())
      OR
      -- 2. Crash recovery (abandoned tasks where worker died or lease expired)
      (status = 'processing' AND lease_expires_at < clock_timestamp())
    )
    ORDER BY next_attempt_at ASC, id ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.refund_task_queue q
  SET status = 'processing',
      attempt_count = q.attempt_count + 1,
      leased_at = clock_timestamp(),
      leased_by = p_worker_id,
      lease_expires_at = v_lease_expiry,
      updated_at = clock_timestamp()
  FROM claimable c
  WHERE q.id = c.id
  RETURNING q.*;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.claim_refund_tasks(INTEGER, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_refund_tasks(INTEGER, TEXT, INTEGER) TO service_role;

-- 7. Job Progress Aggregator and Finalizer RPC
CREATE OR REPLACE FUNCTION public.update_cancellation_job_progress(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job RECORD;
  v_pending_count INTEGER;
  v_uncertain_count INTEGER;
  v_manual_review_count INTEGER;
  v_completed_count INTEGER;
  v_attended_count INTEGER;
BEGIN
  SELECT * INTO v_job FROM public.event_cancellation_jobs WHERE id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Job not found');
  END IF;

  SELECT
    count(*) FILTER (WHERE status IN ('pending', 'processing', 'failed')),
    count(*) FILTER (WHERE status = 'uncertain'),
    count(*) FILTER (WHERE status = 'manual_review'),
    count(*) FILTER (WHERE status = 'completed'),
    count(*) FILTER (WHERE status = 'skipped_attended')
  INTO v_pending_count, v_uncertain_count, v_manual_review_count, v_completed_count, v_attended_count
  FROM public.refund_task_queue
  WHERE job_id = p_job_id;

  -- If all tasks have reached terminal states:
  IF v_pending_count = 0 AND v_uncertain_count = 0 THEN
    IF v_manual_review_count = 0 THEN
      -- 100% Clean Success: Transition event to 'cancelled'
      UPDATE public.event_cancellation_jobs
      SET status = 'completed',
          refunds_succeeded = v_completed_count,
          refunds_skipped_attended = v_attended_count,
          refunds_uncertain = 0,
          refunds_failed = 0,
          completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE id = p_job_id;

      UPDATE public.events
      SET status = 'cancelled', updated_at = clock_timestamp()
      WHERE id = v_job.event_id;

      INSERT INTO public.payment_audit_log (action, details)
      VALUES ('event_cancellation_completed', jsonb_build_object('job_id', p_job_id, 'event_id', v_job.event_id));
    ELSE
      -- Partial Success with Manual Review Required: Event remains 'cancelling'
      UPDATE public.event_cancellation_jobs
      SET status = 'requires_manual_review',
          refunds_succeeded = v_completed_count,
          refunds_skipped_attended = v_attended_count,
          refunds_uncertain = 0,
          refunds_failed = v_manual_review_count,
          completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE id = p_job_id;

      INSERT INTO public.payment_audit_log (action, details)
      VALUES ('event_cancellation_requires_review', jsonb_build_object(
        'job_id', p_job_id, 'event_id', v_job.event_id, 'manual_review_count', v_manual_review_count
      ));
    END IF;
  ELSE
    -- Still in progress
    UPDATE public.event_cancellation_jobs
    SET status = 'processing',
        refunds_succeeded = v_completed_count,
        refunds_skipped_attended = v_attended_count,
        refunds_uncertain = v_uncertain_count,
        refunds_failed = v_manual_review_count,
        updated_at = clock_timestamp()
    WHERE id = p_job_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'pending', v_pending_count,
    'uncertain', v_uncertain_count,
    'manual_review', v_manual_review_count,
    'completed', v_completed_count,
    'skipped_attended', v_attended_count
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.update_cancellation_job_progress(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_cancellation_job_progress(UUID) TO service_role;

-- 8. Authenticated Admin Manual-Review Resolution RPC
CREATE OR REPLACE FUNCTION public.admin_resolve_refund_task(
  p_task_id UUID,
  p_resolution_type TEXT, -- 'adopt_provider_refund' | 'retry_task' | 'manual_settlement'
  p_admin_id UUID,
  p_razorpay_refund_id TEXT DEFAULT NULL,
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
  v_complete_res JSONB;
BEGIN
  -- 1. Verify admin privilege
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
    RETURN jsonb_build_object('error', 'Unauthorized: Admin privileges required');
  END IF;

  -- 2. Lock task row
  SELECT * INTO v_task FROM public.refund_task_queue WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Task not found');
  END IF;

  IF v_task.status = 'completed' THEN
    RETURN jsonb_build_object('error', 'Task is already completed');
  END IF;

  -- 3. Execute Resolution
  IF p_resolution_type = 'adopt_provider_refund' THEN
    IF p_razorpay_refund_id IS NULL OR length(trim(p_razorpay_refund_id)) < 5 THEN
      RETURN jsonb_build_object('error', 'Valid razorpay_refund_id is required for adoption');
    END IF;

    IF v_task.payment_id IS NOT NULL THEN
      -- Settle payment claim
      v_complete_res := public.complete_payment_refund(
        v_task.payment_id,
        TRUE,
        p_razorpay_refund_id,
        'processed',
        v_task.amount,
        'event_cancellation_manual_adopt'
      );
      IF v_complete_res->>'error' IS NOT NULL THEN
        RETURN v_complete_res;
      END IF;
    END IF;

    -- Cancel registration & decrement capacity
    PERFORM public.cancel_registration_and_decrement(v_task.registration_id, clock_timestamp()::text);

    UPDATE public.refund_task_queue
    SET status = 'completed',
        razorpay_refund_id = p_razorpay_refund_id,
        error_message = 'Adopted provider refund by admin: ' || COALESCE(p_notes, ''),
        updated_at = clock_timestamp()
    WHERE id = p_task_id;

  ELSIF p_resolution_type = 'retry_task' THEN
    UPDATE public.refund_task_queue
    SET status = 'pending',
        attempt_count = 0,
        next_attempt_at = clock_timestamp(),
        leased_at = NULL,
        leased_by = NULL,
        lease_expires_at = NULL,
        error_message = 'Retried by admin: ' || COALESCE(p_notes, ''),
        updated_at = clock_timestamp()
    WHERE id = p_task_id;

  ELSIF p_resolution_type = 'manual_settlement' THEN
    IF p_notes IS NULL OR length(trim(p_notes)) < 3 THEN
      RETURN jsonb_build_object('error', 'Settlement notes/reference required for manual settlement');
    END IF;

    IF v_task.payment_id IS NOT NULL THEN
      v_complete_res := public.complete_payment_refund(
        v_task.payment_id,
        TRUE,
        'manual_settle_' || v_task.id,
        'processed',
        v_task.amount,
        'offline_manual_settlement'
      );
      IF v_complete_res->>'error' IS NOT NULL THEN
        RETURN v_complete_res;
      END IF;
    END IF;

    PERFORM public.cancel_registration_and_decrement(v_task.registration_id, clock_timestamp()::text);

    UPDATE public.refund_task_queue
    SET status = 'completed',
        razorpay_refund_id = 'manual_settle_' || v_task.id,
        error_message = 'Manually settled offline: ' || p_notes,
        updated_at = clock_timestamp()
    WHERE id = p_task_id;

  ELSE
    RETURN jsonb_build_object('error', 'Invalid resolution_type: ' || p_resolution_type);
  END IF;

  -- 4. Audit Log
  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES (
    'admin_manual_review_resolved',
    v_task.payment_id,
    jsonb_build_object(
      'task_id', p_task_id,
      'admin_id', p_admin_id,
      'resolution_type', p_resolution_type,
      'razorpay_refund_id', p_razorpay_refund_id,
      'notes', p_notes
    )
  );

  -- 5. Advance Job Progress
  PERFORM public.update_cancellation_job_progress(v_task.job_id);

  RETURN jsonb_build_object('ok', true, 'task_id', p_task_id, 'resolution_type', p_resolution_type);
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_resolve_refund_task(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_resolve_refund_task(UUID, TEXT, UUID, TEXT, TEXT) TO authenticated, service_role;

-- 9. Update confirm_payment RPC Guard to check for 'cancelling'
CREATE OR REPLACE FUNCTION public.confirm_payment(p_payment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment RECORD;
  v_event RECORD;
  v_community RECORD;
  v_updated INTEGER;
  v_platform_fee INTEGER;
  v_platform_fee_gst INTEGER;
  v_organizer_share INTEGER;
  v_discount INTEGER;
BEGIN
  -- Lock the payment row first.
  SELECT p.*, r.status AS reg_status, r.event_id, r.user_id
  INTO v_payment
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  WHERE p.id = p_payment_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment or registration not found');
  END IF;

  -- Idempotency check: already confirmed (or already refunded after confirmation).
  IF v_payment.status IN ('success', 'refunded') THEN
    RETURN jsonb_build_object('skipped', true, 'payment_id', p_payment_id);
  END IF;

  -- Cancelled-registration guard
  IF v_payment.reg_status = 'cancelled' THEN
    UPDATE public.payments
    SET status = 'failed',
        failure_reason = 'registration_cancelled',
        refund_reason = COALESCE(refund_reason, 'registration_cancellation')
    WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id,
      'reason', 'registration_cancellation');
  END IF;

  SELECT e.* INTO v_event FROM public.events e WHERE e.id = v_payment.event_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Event not found');
  END IF;

  -- Guard against both 'cancelled' and 'cancelling' events
  IF v_event.status IN ('cancelled', 'cancelling') THEN
    UPDATE public.payments
    SET status = 'failed',
        failure_reason = 'event_cancelled',
        refund_reason = COALESCE(refund_reason, 'event_cancellation')
    WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id,
      'reason', 'event_cancellation');
  END IF;

  SELECT c.* INTO v_community FROM public.communities c WHERE c.id = v_event.community_id;

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
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id, 'reason', 'capacity_full');
  END IF;

  v_platform_fee := GREATEST(COALESCE(v_payment.platform_fee, 0), 0);
  v_platform_fee_gst := GREATEST(COALESCE(v_payment.platform_fee_gst, 0), 0);
  v_organizer_share := GREATEST(v_payment.amount - v_platform_fee, 0);

  v_discount := CASE
    WHEN v_payment.coupon_id IS NOT NULL
    THEN GREATEST(v_event.price - v_organizer_share, 0)
    ELSE 0
  END;

  UPDATE public.payments
  SET status = 'success',
      platform_fee = v_platform_fee,
      platform_fee_gst = v_platform_fee_gst,
      organizer_share = v_organizer_share,
      failure_reason = NULL
  WHERE id = p_payment_id;

  UPDATE public.registrations
  SET status = 'confirmed',
      qr_code = encode(
        sha256(
          (p_payment_id::text || v_event.id::text || v_payment.registration_id::text)::bytea
        ),
        'hex'
      )
  WHERE id = v_payment.registration_id;

  PERFORM public.credit_wallet(v_community.id, v_organizer_share, v_event.id);

  IF v_payment.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, title, message, type)
    VALUES (
      v_payment.user_id,
      'Booking Confirmed!',
      'Your ticket for "' || v_event.title || '" is confirmed.',
      'booking'
    );
  END IF;

  RETURN jsonb_build_object('action', 'confirmed', 'payment_id', p_payment_id);
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_payment(UUID) TO service_role;
