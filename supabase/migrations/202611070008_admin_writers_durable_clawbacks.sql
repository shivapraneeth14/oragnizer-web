-- ============================================================================
-- CLUVO — Route the remaining admin refund writers through the durable ledger
--
-- 202611050008 taught admin_adopt_provider_refund to defer a failed organizer
-- clawback by setting payments.refund_clawback_state = 'pending'. Now that
-- retry_refund_clawbacks and payout reservation read refund_clawbacks, a debt
-- written only to the mirror would never be retried or reserved again.
--
-- This migration:
--   1. admin_adopt_provider_refund links its refund to the reversed sale and
--      writes the durable refund_clawbacks row.
--   2. admin_manual_settlement (offline settlement) no longer ignores a failed
--      wallet debit: it records the debt, the mirror, and an admin alert.
--   3. retry_refund_clawbacks first sweeps any legacy mirror-only debt into
--      refund_clawbacks, so nothing written by an older release is lost.
--
-- No signatures, JSON contracts, or authorization checks change.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. admin_adopt_provider_refund
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
  v_sale RECORD;
  v_organizer_share INTEGER;
  v_refund_amount INTEGER;
  v_wallet_already_debited BOOLEAN := FALSE;
  v_clean_refund_id TEXT;
  v_attempt INTEGER;
  v_debit JSONB;
  v_clawback_state TEXT := 'none';
  v_refund_row_id UUID;
  v_community_id UUID;
  v_fee_kept INTEGER := 0;
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

  -- 4. Cross-Payment Deduplication
  IF EXISTS (
    SELECT 1 FROM public.payments WHERE razorpay_refund_id = v_clean_refund_id AND id <> v_task.payment_id
    UNION
    SELECT 1 FROM public.payment_refund_history WHERE razorpay_refund_id = v_clean_refund_id AND payment_id <> v_task.payment_id
  ) THEN
    RETURN jsonb_build_object('error', 'Razorpay refund ID is already associated with another payment');
  END IF;

  -- 5. Lock Payment Row
  SELECT * INTO v_payment FROM public.payments WHERE id = v_task.payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  v_attempt := COALESCE(NULLIF(v_payment.refund_attempt_count, 0), 1);

  -- The sale this refund reverses. Snapshot its amounts so a later requote
  -- cannot change the value of a historical refund.
  SELECT s.* INTO v_sale
  FROM public.payment_sales s
  WHERE s.id = public.current_sale_id(v_payment.id);

  v_refund_amount := COALESCE(v_sale.ticket_amount, v_payment.organizer_share, v_payment.amount);

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
    IF v_reg.status = 'attended' THEN
      RETURN jsonb_build_object(
        'error', 'not_refundable_attended',
        'message', 'Cannot adopt refund: Attendee has already attended the event'
      );
    END IF;

    IF v_reg.event_id IS NOT NULL THEN
      SELECT e.community_id INTO v_event FROM public.events e WHERE e.id = v_reg.event_id;
      v_community_id := COALESCE(v_sale.community_id, v_event.community_id);

      IF v_community_id IS NOT NULL THEN
        v_organizer_share := GREATEST(COALESCE(v_sale.ticket_amount, v_payment.organizer_share, 0), 0);
        v_fee_kept := GREATEST(COALESCE(v_sale.platform_fee, v_payment.platform_fee, 0), 0);

        IF v_organizer_share <= 0 THEN
          v_clawback_state := 'done';
        ELSIF v_wallet_already_debited THEN
          v_clawback_state := 'done';
        ELSE
          SELECT * INTO v_debit
          FROM public.debit_wallet(
            v_community_id,
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
                'sale_id', v_sale.id,
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
                  'community_id', v_community_id,
                  'event_id', v_reg.event_id,
                  'amount', v_organizer_share,
                  'refund_id', v_clean_refund_id,
                  'sale_id', v_sale.id,
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

  -- 10. Archive into payment_refund_history, linked to the sale.
  INSERT INTO public.payment_refund_history (
    payment_id, registration_id, event_id, amount, payment_amount, platform_fee,
    refund_status, razorpay_refund_id, refund_reason, created_at,
    sale_id, community_id, refund_amount, fee_kept, organizer_clawed,
    requested_at, processed_at, currency, source
  ) VALUES (
    v_payment.id, v_payment.registration_id, v_task.event_id,
    v_refund_amount, COALESCE(v_sale.gross_amount, v_payment.amount),
    COALESCE(v_sale.platform_fee, v_payment.platform_fee),
    'processed', v_clean_refund_id, 'event_cancellation_manual_adopt', clock_timestamp(),
    v_sale.id, v_community_id, v_refund_amount, v_fee_kept,
    LEAST(v_refund_amount, GREATEST(v_organizer_share, 0)),
    clock_timestamp(), clock_timestamp(),
    COALESCE(v_sale.currency, v_payment.currency, 'INR'), 'live'
  ) ON CONFLICT (payment_id, razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL
  DO UPDATE SET
    refund_status = 'processed',
    sale_id = COALESCE(payment_refund_history.sale_id, EXCLUDED.sale_id),
    community_id = COALESCE(payment_refund_history.community_id, EXCLUDED.community_id),
    refund_amount = COALESCE(payment_refund_history.refund_amount, EXCLUDED.refund_amount),
    organizer_clawed = CASE WHEN payment_refund_history.organizer_clawed = 0
      THEN EXCLUDED.organizer_clawed ELSE payment_refund_history.organizer_clawed END,
    updated_at = clock_timestamp()
  RETURNING id INTO v_refund_row_id;

  -- 11. Durable clawback debt (never only the mirror).
  IF v_refund_row_id IS NOT NULL
     AND v_organizer_share > 0
     AND v_sale.id IS NOT NULL
     AND v_community_id IS NOT NULL THEN
    INSERT INTO public.refund_clawbacks (
      refund_id, payment_id, sale_id, community_id, event_id, amount, state, created_at, settled_at
    ) VALUES (
      v_refund_row_id, v_payment.id, v_sale.id, v_community_id, v_reg.event_id,
      LEAST(v_refund_amount, v_organizer_share),
      CASE WHEN v_clawback_state = 'done' THEN 'done' ELSE 'pending' END,
      clock_timestamp(),
      CASE WHEN v_clawback_state = 'done' THEN clock_timestamp() ELSE NULL END
    )
    ON CONFLICT (refund_id) DO NOTHING;

    IF v_clawback_state = 'done' THEN
      UPDATE public.refund_clawbacks
      SET state = 'done',
          settled_at = COALESCE(settled_at, clock_timestamp())
      WHERE refund_id = v_refund_row_id
        AND state = 'pending';
    END IF;
  END IF;

  -- 12. Cancel registration and decrement capacity
  PERFORM public.cancel_registration_and_decrement(v_task.registration_id, clock_timestamp());

  -- 13. Complete Queue Task
  UPDATE public.refund_task_queue
  SET status = 'completed',
      amount = v_refund_amount,
      razorpay_refund_id = v_clean_refund_id,
      error_message = 'Adopted verified provider refund: ' || COALESCE(p_notes, ''),
      updated_at = clock_timestamp()
  WHERE id = p_task_id;

  -- 14. Update Job Progress
  PERFORM public.update_cancellation_job_progress(v_task.job_id);

  -- 15. Audit Log
  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('admin_adopt_provider_refund', v_payment.id,
    jsonb_build_object(
      'admin_id', p_admin_id,
      'task_id', p_task_id,
      'refund_id', v_clean_refund_id,
      'amount', v_refund_amount,
      'notes', p_notes,
      'sale_id', v_sale.id,
      'refund_row_id', v_refund_row_id,
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

-- ----------------------------------------------------------------------------
-- 2. admin_manual_settlement
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
  v_sale RECORD;
  v_organizer_share INTEGER;
  v_refund_amount INTEGER;
  v_wallet_already_debited BOOLEAN := FALSE;
  v_settle_id TEXT;
  v_method TEXT;
  v_ref TEXT;
  v_notes TEXT;
  v_debit JSONB;
  v_clawback_state TEXT := 'none';
  v_refund_row_id UUID;
  v_community_id UUID;
  v_fee_kept INTEGER := 0;
  v_attempt INTEGER;
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

  -- 4. Global Reference Uniqueness
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

  v_attempt := COALESCE(NULLIF(v_payment.refund_attempt_count, 0), 1);

  SELECT s.* INTO v_sale
  FROM public.payment_sales s
  WHERE s.id = public.current_sale_id(v_payment.id);

  v_refund_amount := COALESCE(v_sale.ticket_amount, v_payment.organizer_share, v_payment.amount);

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
    IF v_reg.status = 'attended' THEN
      RETURN jsonb_build_object(
        'error', 'not_refundable_attended',
        'message', 'Cannot manually settle refund: Attendee has already attended the event'
      );
    END IF;

    IF v_reg.event_id IS NOT NULL THEN
      SELECT e.community_id INTO v_event FROM public.events e WHERE e.id = v_reg.event_id;
      v_community_id := COALESCE(v_sale.community_id, v_event.community_id);

      IF v_community_id IS NOT NULL THEN
        v_organizer_share := GREATEST(COALESCE(v_sale.ticket_amount, v_payment.organizer_share, 0), 0);
        v_fee_kept := GREATEST(COALESCE(v_sale.platform_fee, v_payment.platform_fee, 0), 0);

        IF v_organizer_share <= 0 OR v_wallet_already_debited THEN
          v_clawback_state := 'done';
        ELSE
          SELECT * INTO v_debit
          FROM public.debit_wallet(
            v_community_id,
            v_organizer_share,
            'offline_manual_settlement',
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
                'settle_id', v_settle_id,
                'amount', v_organizer_share,
                'attempt', v_attempt,
                'sale_id', v_sale.id,
                'error', COALESCE(v_debit->>'error', 'Wallet debit failed'),
                'note', 'Offline refund settled but the organizer wallet is short — retry scheduled'
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
                  'community_id', v_community_id,
                  'event_id', v_reg.event_id,
                  'amount', v_organizer_share,
                  'settle_id', v_settle_id,
                  'sale_id', v_sale.id,
                  'note', 'Customer was refunded offline, but the organizer wallet did not have enough balance. It will be retried automatically.'
                )
              );
            END IF;
          END IF;
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
      refund_clawback_state = v_clawback_state,
      refund_wallet_debited_attempt = CASE WHEN v_clawback_state = 'done' THEN v_attempt ELSE 0 END,
      updated_at = clock_timestamp()
  WHERE id = v_payment.id;

  -- 9. Archive into payment_refund_history, linked to the sale.
  INSERT INTO public.payment_refund_history (
    payment_id, registration_id, event_id, amount, payment_amount, platform_fee,
    refund_status, razorpay_refund_id, refund_reason, created_at,
    sale_id, community_id, refund_amount, fee_kept, organizer_clawed,
    requested_at, processed_at, currency, source
  ) VALUES (
    v_payment.id, v_payment.registration_id, v_task.event_id,
    v_refund_amount, COALESCE(v_sale.gross_amount, v_payment.amount),
    COALESCE(v_sale.platform_fee, v_payment.platform_fee),
    'processed', v_settle_id, 'offline_manual_settlement', clock_timestamp(),
    v_sale.id, v_community_id, v_refund_amount, v_fee_kept,
    LEAST(v_refund_amount, GREATEST(v_organizer_share, 0)),
    clock_timestamp(), clock_timestamp(),
    COALESCE(v_sale.currency, v_payment.currency, 'INR'), 'live'
  ) ON CONFLICT (payment_id, razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL
  DO UPDATE SET
    refund_status = 'processed',
    sale_id = COALESCE(payment_refund_history.sale_id, EXCLUDED.sale_id),
    community_id = COALESCE(payment_refund_history.community_id, EXCLUDED.community_id),
    refund_amount = COALESCE(payment_refund_history.refund_amount, EXCLUDED.refund_amount),
    organizer_clawed = CASE WHEN payment_refund_history.organizer_clawed = 0
      THEN EXCLUDED.organizer_clawed ELSE payment_refund_history.organizer_clawed END,
    updated_at = clock_timestamp()
  RETURNING id INTO v_refund_row_id;

  -- 10. Durable clawback debt.
  IF v_refund_row_id IS NOT NULL
     AND v_organizer_share > 0
     AND v_sale.id IS NOT NULL
     AND v_community_id IS NOT NULL THEN
    INSERT INTO public.refund_clawbacks (
      refund_id, payment_id, sale_id, community_id, event_id, amount, state, created_at, settled_at
    ) VALUES (
      v_refund_row_id, v_payment.id, v_sale.id, v_community_id, v_reg.event_id,
      LEAST(v_refund_amount, v_organizer_share),
      CASE WHEN v_clawback_state = 'done' THEN 'done' ELSE 'pending' END,
      clock_timestamp(),
      CASE WHEN v_clawback_state = 'done' THEN clock_timestamp() ELSE NULL END
    )
    ON CONFLICT (refund_id) DO NOTHING;

    IF v_clawback_state = 'done' THEN
      UPDATE public.refund_clawbacks
      SET state = 'done',
          settled_at = COALESCE(settled_at, clock_timestamp())
      WHERE refund_id = v_refund_row_id
        AND state = 'pending';
    END IF;
  END IF;

  -- 11. Cancel registration & decrement capacity
  PERFORM public.cancel_registration_and_decrement(v_task.registration_id, clock_timestamp());

  -- 12. Complete Queue Task
  UPDATE public.refund_task_queue
  SET status = 'completed',
      amount = v_refund_amount,
      razorpay_refund_id = v_settle_id,
      error_message = 'Manually settled offline: ' || v_ref || ' (' || v_method || ')',
      updated_at = clock_timestamp()
  WHERE id = p_task_id;

  -- 13. Update Job Progress
  PERFORM public.update_cancellation_job_progress(v_task.job_id);

  -- 14. Audit Log with Full Structured Evidence
  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('offline_manual_settlement', v_payment.id,
    jsonb_build_object(
      'admin_id', p_admin_id,
      'task_id', p_task_id,
      'settle_id', v_settle_id,
      'amount', v_refund_amount,
      'sale_id', v_sale.id,
      'refund_row_id', v_refund_row_id,
      'evidence', p_evidence,
      'wallet_already_debited', v_wallet_already_debited,
      'clawback_state', v_clawback_state
    ));

  RETURN jsonb_build_object(
    'ok', true, 'task_id', p_task_id, 'settle_id', v_settle_id,
    'amount', v_refund_amount, 'clawback_state', v_clawback_state
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_manual_settlement(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_manual_settlement(UUID, UUID, JSONB)
  TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. retry_refund_clawbacks — sweep legacy mirror-only debt first
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retry_refund_clawbacks(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cb RECORD;
  v_registration RECORD;
  v_debit JSONB;
  v_attempted INTEGER := 0;
  v_debited INTEGER := 0;
  v_pending INTEGER := 0;
BEGIN
  -- Safety net for debt written by a release that only knew the mirror column.
  -- The durable row is the authoritative copy from now on.
  INSERT INTO public.refund_clawbacks (
    refund_id, payment_id, sale_id, community_id, event_id, amount, state, created_at
  )
  SELECT
    h.id, p.id, COALESCE(h.sale_id, public.current_sale_id(p.id)),
    e.community_id, r.event_id,
    GREATEST(COALESCE(h.organizer_clawed, 0), 0),
    'pending', COALESCE(p.updated_at, now())
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  JOIN public.events e ON e.id = r.event_id
  JOIN LATERAL (
    SELECT h2.*
    FROM public.payment_refund_history h2
    WHERE h2.payment_id = p.id
      AND h2.refund_status = 'processed'
      AND COALESCE(h2.sale_id, public.current_sale_id(p.id)) IS NOT NULL
    ORDER BY h2.created_at DESC
    LIMIT 1
  ) h ON TRUE
  WHERE p.refund_clawback_state = 'pending'
    AND p.refund_status = 'processed'
    AND GREATEST(COALESCE(h.organizer_clawed, 0), 0) > 0
  ON CONFLICT (refund_id) DO NOTHING;

  FOR v_cb IN
    SELECT *
    FROM public.refund_clawbacks
    WHERE state = 'pending'
    ORDER BY created_at
    LIMIT GREATEST(COALESCE(p_limit, 50), 1)
    FOR UPDATE SKIP LOCKED
  LOOP
    v_attempted := v_attempted + 1;

    SELECT r.id, r.event_id INTO v_registration
    FROM public.registrations r
    WHERE r.id = (SELECT registration_id FROM public.payments WHERE id = v_cb.payment_id);

    SELECT * INTO v_debit
    FROM public.debit_wallet(
      v_cb.community_id,
      v_cb.amount,
      'payment_refund',
      v_cb.event_id,
      v_cb.payment_id
    );

    IF COALESCE(v_debit->>'error', '') = '' THEN
      UPDATE public.refund_clawbacks
      SET state = 'done',
          attempts = attempts + 1,
          last_error = NULL,
          settled_at = clock_timestamp()
      WHERE id = v_cb.id;

      UPDATE public.payments
      SET refund_clawback_state = 'done',
          refund_wallet_debited_attempt = GREATEST(COALESCE(refund_attempt_count, 0), 1)
      WHERE id = v_cb.payment_id;

      INSERT INTO public.payment_audit_log (action, payment_id, details)
      VALUES ('refund_clawback_settled', v_cb.payment_id,
        jsonb_build_object(
          'amount', v_cb.amount,
          'sale_id', v_cb.sale_id,
          'clawback_id', v_cb.id,
          'new_balance', v_debit->>'new_balance',
          'source', 'retry_refund_clawbacks'
        ));

      v_debited := v_debited + 1;
    ELSE
      UPDATE public.refund_clawbacks
      SET attempts = attempts + 1,
          last_error = COALESCE(v_debit->>'error', 'Wallet debit failed')
      WHERE id = v_cb.id;
      v_pending := v_pending + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'attempted', v_attempted,
    'debited', v_debited,
    'pending', v_pending
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.retry_refund_clawbacks(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_refund_clawbacks(INTEGER) TO service_role;
