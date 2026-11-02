-- ============================================================================
-- CLUVO STAGE 6 REMEDIATION — MIGRATION 15:
-- REF-003: Verified Provider-Refund Adoption and Independently Audited Manual Settlement
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. admin_adopt_provider_refund(p_task_id, p_admin_id, p_razorpay_refund_id, p_notes)
--    Adopts an independently verified provider refund.
--    Enforces provider ID format, cross-payment deduplication, in-flight worker
--    isolation, and append-only ledger inspection to guarantee zero double debit.
-- ----------------------------------------------------------------------------
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
        v_organizer_share := COALESCE(
          v_payment.organizer_share,
          GREATEST(COALESCE(v_payment.amount, 0) - COALESCE(v_payment.platform_fee, 0), 0)
        );

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
      refunded_amount = v_task.amount,
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
    v_task.amount, v_payment.amount, v_payment.platform_fee,
    'processed', v_clean_refund_id, 'event_cancellation_manual_adopt', clock_timestamp()
  ) ON CONFLICT (payment_id, razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL
  DO UPDATE SET refund_status = 'processed', updated_at = clock_timestamp();

  -- 11. Cancel registration and decrement capacity
  PERFORM public.cancel_registration_and_decrement(v_task.registration_id, clock_timestamp());

  -- 12. Complete Queue Task
  UPDATE public.refund_task_queue
  SET status = 'completed',
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
      'amount', v_task.amount,
      'notes', p_notes,
      'wallet_already_debited', v_wallet_already_debited
    ));

  RETURN jsonb_build_object('ok', true, 'task_id', p_task_id, 'refund_id', v_clean_refund_id);
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_adopt_provider_refund(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adopt_provider_refund(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. admin_manual_settlement(p_task_id, p_admin_id, p_evidence)
--    Performs manual settlement with mandatory structured financial evidence.
--    Requires settlement method, minimum 10-char reference (e.g. UTR), notes,
--    and verifies zero global reference duplication.
-- ----------------------------------------------------------------------------
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
        v_organizer_share := COALESCE(
          v_payment.organizer_share,
          GREATEST(COALESCE(v_payment.amount, 0) - COALESCE(v_payment.platform_fee, 0), 0)
        );

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
      refunded_amount = v_task.amount,
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
    v_task.amount, v_payment.amount, v_payment.platform_fee,
    'processed', v_settle_id, 'offline_manual_settlement', clock_timestamp()
  ) ON CONFLICT (payment_id, razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL
  DO NOTHING;

  -- 10. Cancel registration & decrement capacity
  PERFORM public.cancel_registration_and_decrement(v_task.registration_id, clock_timestamp());

  -- 11. Complete Queue Task
  UPDATE public.refund_task_queue
  SET status = 'completed',
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
      'amount', v_task.amount,
      'evidence', p_evidence,
      'wallet_already_debited', v_wallet_already_debited
    ));

  RETURN jsonb_build_object('ok', true, 'task_id', p_task_id, 'settle_id', v_settle_id);
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_manual_settlement(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_manual_settlement(UUID, UUID, JSONB) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. Backward-Compatible Dispatcher: admin_resolve_refund_task
--    Preserves existing RPC signature while dispatching to verified adoption
--    or structured evidence manual settlement.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_resolve_refund_task(
  p_task_id UUID,
  p_resolution_type TEXT,
  p_admin_id UUID,
  p_razorpay_refund_id TEXT,
  p_notes TEXT,
  p_evidence JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_resolution_type = 'adopt_provider_refund' THEN
    RETURN public.admin_adopt_provider_refund(p_task_id, p_admin_id, p_razorpay_refund_id, p_notes);

  ELSIF p_resolution_type = 'manual_settlement' THEN
    RETURN public.admin_manual_settlement(
      p_task_id,
      p_admin_id,
      COALESCE(
        p_evidence,
        jsonb_build_object(
          'settlement_method', 'bank_transfer',
          'reference_number', p_razorpay_refund_id,
          'notes', p_notes
        )
      )
    );

  ELSIF p_resolution_type = 'retry_task' THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
      RETURN jsonb_build_object('error', 'Unauthorized: Admin privileges required');
    END IF;

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

    RETURN jsonb_build_object('ok', true, 'task_id', p_task_id, 'status', 'pending');

  ELSE
    RETURN jsonb_build_object('error', 'Invalid resolution_type: ' || p_resolution_type);
  END IF;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_resolve_refund_task(UUID, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resolve_refund_task(UUID, TEXT, UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;

-- 5-argument backward compatible overload
-- NOTE: defaults MUST match the existing tracked signature (202610310001) —
-- CREATE OR REPLACE cannot remove parameter defaults (SQLSTATE 42P13).
CREATE OR REPLACE FUNCTION public.admin_resolve_refund_task(
  p_task_id UUID,
  p_resolution_type TEXT,
  p_admin_id UUID,
  p_razorpay_refund_id TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.admin_resolve_refund_task(p_task_id, p_resolution_type, p_admin_id, p_razorpay_refund_id, p_notes, NULL::JSONB);
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_resolve_refund_task(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resolve_refund_task(UUID, TEXT, UUID, TEXT, TEXT) TO authenticated, service_role;

-- Backward-compatible overload for cancel_registration_and_decrement accepting TEXT timestamp
CREATE OR REPLACE FUNCTION public.cancel_registration_and_decrement(
  p_registration_id UUID,
  p_deleted_at TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.cancel_registration_and_decrement(
    p_registration_id,
    CASE WHEN p_deleted_at IS NOT NULL AND p_deleted_at <> '' THEN p_deleted_at::TIMESTAMPTZ ELSE NULL END
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.cancel_registration_and_decrement(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_registration_and_decrement(UUID, TEXT) TO service_role;


