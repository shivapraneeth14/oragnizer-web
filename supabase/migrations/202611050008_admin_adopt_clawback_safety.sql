-- ============================================================================
-- CLUVO — Adoption of a verified provider refund must not silently lose the
-- organizer clawback when the wallet is short.
--
-- admin_adopt_provider_refund previously called debit_wallet and ignored the
-- returned error, then marked the refund processed. If the wallet did not have
-- enough balance the money was never clawed back and no retry was scheduled.
-- It now uses the same clawback bookkeeping as settle_payment_refund:
--   success -> refund_clawback_state='done' (wallet debited exactly once)
--   failure -> refund_clawback_state='pending' + admin alert, retried by
--              retry_refund_clawbacks on the next reconcile run
-- ============================================================================

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
  v_attempt INTEGER;
  v_debit JSONB;
  v_clawback_state TEXT := 'none';
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

  v_attempt := COALESCE(NULLIF(v_payment.refund_attempt_count, 0), 1);

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

        IF v_organizer_share <= 0 THEN
          v_clawback_state := 'done';
        ELSIF v_wallet_already_debited THEN
          -- A previous settle/attempt already debited this payment.
          v_clawback_state := 'done';
        ELSE
          SELECT * INTO v_debit
          FROM public.debit_wallet(
            v_event.community_id,
            v_organizer_share,
            'event_cancellation_manual_adopt',
            v_reg.event_id,
            v_payment.id
          );

          IF COALESCE(v_debit->>'error', '') = '' THEN
            v_clawback_state := 'done';
          ELSE
            v_clawback_state := 'pending';

            INSERT INTO public.payment_audit_log (action, payment_id, details)
            VALUES ('refund_wallet_debit_failed', v_payment.id,
              jsonb_build_object(
                'refund_id', v_clean_refund_id,
                'amount', v_organizer_share,
                'attempt', v_attempt,
                'error', COALESCE(v_debit->>'error', 'Wallet debit failed'),
                'note', 'Customer was refunded but the organizer clawback is short — retry scheduled'
              ));

            IF NOT EXISTS (
              SELECT 1 FROM public.admin_alerts a
              WHERE a.status = 'open'
                AND a.title = 'Refund clawback pending: organizer wallet short'
                AND a.details->>'payment_id' = v_payment.id::TEXT
            ) THEN
              INSERT INTO public.admin_alerts (severity, category, title, details)
              VALUES (
                'critical',
                'payment',
                'Refund clawback pending: organizer wallet short',
                jsonb_build_object(
                  'payment_id', v_payment.id,
                  'community_id', v_event.community_id,
                  'event_id', v_reg.event_id,
                  'amount', v_organizer_share,
                  'refund_id', v_clean_refund_id,
                  'note', 'Customer was refunded, but the organizer wallet did not have enough balance. It will be retried automatically.'
                )
              );
            END IF;
          END IF;
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
      refund_clawback_state = v_clawback_state,
      refund_wallet_debited_attempt = CASE WHEN v_clawback_state = 'done' THEN v_attempt ELSE 0 END,
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
      'wallet_already_debited', v_wallet_already_debited,
      'clawback_state', v_clawback_state
    ));

  RETURN jsonb_build_object(
    'ok', true,
    'task_id', p_task_id,
    'refund_id', v_clean_refund_id,
    'amount', v_refund_amount,
    'clawback_state', v_clawback_state
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_adopt_provider_refund(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adopt_provider_refund(UUID, UUID, TEXT, TEXT)
  TO authenticated, service_role;
