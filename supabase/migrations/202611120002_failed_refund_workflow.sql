-- ============================================================================
-- CLUVO — Failed-refund manual settlement (UPI fallback)
--
-- Adds the admin workflow for a refund that Razorpay cannot complete:
--   request UPI  -> customer gives UPI -> admin records it -> admin marks paid.
--
-- This migration only ADDS:
--   * payments.refund_settlement_type  ('manual_offline' label)
--   * refund_workflows                 (admin contact/settlement state)
--   * mark_refund_upi_requested        (state transition)
--   * record_refund_upi                (state transition)
--   * admin_manual_settle_payment      (the money move, keyed on payment)
--
-- The money move deliberately mirrors the already-proven
-- admin_manual_settlement() clawback block: debit the organizer exactly once,
-- resolve the durable clawback, clear refund_amount_due, mark the payment
-- refunded, archive history, cancel the registration and (if present) close
-- the event-cancellation task + recompute the job.
-- ============================================================================

-- 1. Label manual settlements without touching the refund_status CHECK domain.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refund_settlement_type TEXT;

-- 2. Admin contact/settlement state per failed refund.
CREATE TABLE IF NOT EXISTS public.refund_workflows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  UUID NOT NULL UNIQUE REFERENCES public.payments(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'upi_requested'
              CHECK (status IN ('upi_requested', 'upi_received', 'settled')),
  upi_id      TEXT,
  utr         TEXT UNIQUE,
  admin_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.refund_workflows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS refund_workflows_admin_read ON public.refund_workflows;
CREATE POLICY refund_workflows_admin_read ON public.refund_workflows
  FOR SELECT USING (public.is_admin_user());

REVOKE ALL ON public.refund_workflows FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.refund_workflows TO authenticated;
GRANT ALL ON public.refund_workflows TO service_role;

-- 3. Mark that support asked the customer for a UPI ID.
CREATE OR REPLACE FUNCTION public.mark_refund_upi_requested(
  p_payment_id UUID,
  p_admin_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_refund_status TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_admin_id THEN
    RETURN jsonb_build_object('error', 'Unauthorized: caller identity mismatch');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
    RETURN jsonb_build_object('error', 'Unauthorized: Admin privileges required');
  END IF;

  SELECT refund_status INTO v_refund_status
  FROM public.payments WHERE id = p_payment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;
  IF v_refund_status IS DISTINCT FROM 'failed' THEN
    RETURN jsonb_build_object('error', 'Payment refund is not in a failed state');
  END IF;

  INSERT INTO public.refund_workflows (payment_id, status, admin_id, updated_at)
  VALUES (p_payment_id, 'upi_requested', p_admin_id, clock_timestamp())
  ON CONFLICT (payment_id) DO UPDATE
    SET status = CASE
          WHEN public.refund_workflows.status IN ('upi_received', 'settled')
            THEN public.refund_workflows.status
          ELSE 'upi_requested'
        END,
        admin_id = EXCLUDED.admin_id,
        updated_at = clock_timestamp();

  RETURN jsonb_build_object('ok', true, 'status', 'upi_requested');
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.mark_refund_upi_requested(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_refund_upi_requested(UUID, UUID)
  TO authenticated, service_role;

-- 4. Record the UPI ID the customer supplied.
CREATE OR REPLACE FUNCTION public.record_refund_upi(
  p_payment_id UUID,
  p_admin_id UUID,
  p_upi_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_upi TEXT;
  v_refund_status TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_admin_id THEN
    RETURN jsonb_build_object('error', 'Unauthorized: caller identity mismatch');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
    RETURN jsonb_build_object('error', 'Unauthorized: Admin privileges required');
  END IF;

  v_upi := trim(COALESCE(p_upi_id, ''));
  IF v_upi !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,60}@[A-Za-z][A-Za-z0-9.-]{1,60}$' THEN
    RETURN jsonb_build_object('error', 'Invalid UPI ID');
  END IF;

  SELECT refund_status INTO v_refund_status
  FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;
  IF v_refund_status = 'processed' THEN
    RETURN jsonb_build_object('error', 'Refund is already completed');
  END IF;
  IF v_refund_status IS DISTINCT FROM 'failed' THEN
    RETURN jsonb_build_object('error', 'Payment refund is not in a failed state');
  END IF;

  INSERT INTO public.refund_workflows (payment_id, status, upi_id, admin_id, updated_at)
  VALUES (p_payment_id, 'upi_received', v_upi, p_admin_id, clock_timestamp())
  ON CONFLICT (payment_id) DO UPDATE
    SET status = CASE
          WHEN public.refund_workflows.status = 'settled' THEN 'settled'
          ELSE 'upi_received'
        END,
        upi_id = EXCLUDED.upi_id,
        admin_id = EXCLUDED.admin_id,
        updated_at = clock_timestamp();

  RETURN jsonb_build_object('ok', true, 'status', 'upi_received');
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.record_refund_upi(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_refund_upi(UUID, UUID, TEXT)
  TO authenticated, service_role;

-- 5. The money move: record an offline UPI settlement for a failed refund.
CREATE OR REPLACE FUNCTION public.admin_manual_settle_payment(
  p_payment_id UUID,
  p_admin_id UUID,
  p_evidence JSONB
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
  v_sale RECORD;
  v_task RECORD;
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
  -- 1. Verify admin + caller identity.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_admin_id THEN
    RETURN jsonb_build_object('error', 'Unauthorized: caller identity mismatch');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
    RETURN jsonb_build_object('error', 'Unauthorized: Admin privileges required');
  END IF;

  -- 2. Validate structured evidence.
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

  -- 3. Lock the payment row. Re-check under the lock so a provider refund that
  --    landed between the edge-function provider check and now can never be
  --    settled twice.
  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  IF v_payment.refund_status = 'processed' OR v_payment.refund_claim_state = 'issued' THEN
    RETURN jsonb_build_object('error', 'Payment is already refunded');
  END IF;

  IF v_payment.refund_status IS DISTINCT FROM 'failed' THEN
    RETURN jsonb_build_object('error', 'Payment refund is not in a failed state');
  END IF;

  -- 4. Global reference uniqueness.
  IF EXISTS (
    SELECT 1 FROM public.payment_audit_log
    WHERE action = 'offline_manual_settlement'
      AND details->'evidence'->>'reference_number' = v_ref
  ) THEN
    RETURN jsonb_build_object('error', 'Reference number has already been used for another offline settlement');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.refund_workflows
    WHERE utr = v_ref AND payment_id <> p_payment_id
  ) THEN
    RETURN jsonb_build_object('error', 'This UTR has already been used for another refund');
  END IF;

  v_attempt := COALESCE(NULLIF(v_payment.refund_attempt_count, 0), 1);

  -- 5. Registration / event / community + attended guard.
  SELECT r.id, r.event_id, r.status, r.user_id INTO v_reg
  FROM public.registrations r
  WHERE r.id = v_payment.registration_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Registration not found');
  END IF;

  IF v_reg.status = 'attended' THEN
    RETURN jsonb_build_object(
      'error', 'not_refundable_attended',
      'message', 'Cannot manually settle refund: Attendee has already attended the event'
    );
  END IF;

  SELECT * INTO v_event FROM public.events WHERE id = v_reg.event_id;
  v_community_id := v_event.community_id;

  SELECT s.* INTO v_sale
  FROM public.payment_sales s
  WHERE s.id = public.current_sale_id(v_payment.id);

  v_refund_amount := COALESCE(v_sale.ticket_amount, v_payment.organizer_share, v_payment.amount);
  v_organizer_share := GREATEST(COALESCE(v_sale.ticket_amount, v_payment.organizer_share, 0), 0);
  v_fee_kept := GREATEST(COALESCE(v_sale.platform_fee, v_payment.platform_fee, 0), 0);

  -- 6. Any event-cancellation task for this payment?
  SELECT * INTO v_task
  FROM public.refund_task_queue
  WHERE payment_id = p_payment_id
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  v_settle_id := 'manual_settle_' || COALESCE(v_task.id::TEXT, p_payment_id::TEXT);

  -- 7. Zero-double-debit inspection.
  SELECT EXISTS (
    SELECT 1 FROM public.payment_audit_log
    WHERE payment_id = p_payment_id
      AND action = 'wallet_debited'
  ) INTO v_wallet_already_debited;

  -- 8. Debit the organizer share exactly once.
  IF v_organizer_share <= 0 OR v_community_id IS NULL OR v_wallet_already_debited THEN
    v_clawback_state := 'done';
  ELSE
    SELECT * INTO v_debit
    FROM public.debit_wallet(
      v_community_id,
      v_organizer_share,
      'offline_manual_settlement',
      v_reg.event_id,
      p_payment_id
    );

    IF COALESCE(v_debit->>'error', '') = '' THEN
      v_clawback_state := 'done';
    ELSE
      v_clawback_state := 'pending';

      INSERT INTO public.payment_audit_log (action, payment_id, details)
      VALUES ('refund_wallet_debit_failed', p_payment_id,
        jsonb_build_object(
          'settle_id', v_settle_id,
          'amount', v_organizer_share,
          'attempt', v_attempt,
          'error', COALESCE(v_debit->>'error', 'Wallet debit failed'),
          'note', 'Offline refund settled but the organizer wallet is short — retry scheduled'
        ));

      IF NOT EXISTS (
        SELECT 1 FROM public.admin_alerts a
        WHERE a.status = 'open'
          AND a.title = 'Refund clawback pending: organizer wallet short'
          AND a.details->>'payment_id' = p_payment_id::TEXT
      ) THEN
        INSERT INTO public.admin_alerts (severity, category, title, details)
        VALUES (
          'critical',
          'payment',
          'Refund clawback pending: organizer wallet short',
          jsonb_build_object(
            'payment_id', p_payment_id,
            'community_id', v_community_id,
            'event_id', v_reg.event_id,
            'amount', v_organizer_share,
            'settle_id', v_settle_id,
            'note', 'Customer was refunded offline, but the organizer wallet did not have enough balance. It will be retried automatically.'
          )
        );
      END IF;
    END IF;
  END IF;

  -- 9. Persist payment refund truth.
  UPDATE public.payments
  SET status = 'refunded',
      refund_status = 'processed',
      refund_settlement_type = 'manual_offline',
      razorpay_refund_id = v_settle_id,
      refunded_amount = v_refund_amount,
      refund_amount_due = NULL,
      refund_claim_state = 'issued',
      refund_claim_at = clock_timestamp(),
      refund_clawback_state = v_clawback_state,
      refund_wallet_debited_attempt = CASE WHEN v_clawback_state = 'done' THEN v_attempt ELSE 0 END,
      updated_at = clock_timestamp()
  WHERE id = p_payment_id;

  -- 10. Archive into the refund ledger.
  INSERT INTO public.payment_refund_history (
    payment_id, registration_id, event_id, amount, payment_amount, platform_fee,
    refund_status, razorpay_refund_id, refund_reason, created_at,
    sale_id, community_id, refund_amount, fee_kept, organizer_clawed,
    requested_at, processed_at, currency, source
  ) VALUES (
    p_payment_id, v_payment.registration_id, v_reg.event_id,
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

  -- 11. Durable clawback debt.
  IF v_refund_row_id IS NOT NULL
     AND v_organizer_share > 0
     AND v_sale.id IS NOT NULL
     AND v_community_id IS NOT NULL THEN
    INSERT INTO public.refund_clawbacks (
      refund_id, payment_id, sale_id, community_id, event_id, amount, state, created_at, settled_at
    ) VALUES (
      v_refund_row_id, p_payment_id, v_sale.id, v_community_id, v_reg.event_id,
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

  -- 12. Cancel the registration (idempotent; attended already rejected).
  PERFORM public.cancel_registration_and_decrement(v_payment.registration_id, clock_timestamp());

  -- 13. Close the event-cancellation task + wake the job, if one exists.
  IF v_task.id IS NOT NULL AND v_task.status <> 'completed' THEN
    UPDATE public.refund_task_queue
    SET status = 'completed',
        amount = v_refund_amount,
        razorpay_refund_id = v_settle_id,
        error_message = 'Manually settled offline: ' || v_ref || ' (' || v_method || ')',
        updated_at = clock_timestamp()
    WHERE id = v_task.id;

    PERFORM public.update_cancellation_job_progress(v_task.job_id);
  END IF;

  -- 14. Mark the admin workflow settled.
  INSERT INTO public.refund_workflows (payment_id, status, utr, admin_id, notes, updated_at)
  VALUES (p_payment_id, 'settled', v_ref, p_admin_id, v_notes, clock_timestamp())
  ON CONFLICT (payment_id) DO UPDATE
    SET status = 'settled',
        utr = EXCLUDED.utr,
        admin_id = EXCLUDED.admin_id,
        notes = EXCLUDED.notes,
        updated_at = clock_timestamp();

  -- 15. Customer notification.
  IF v_reg.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, body, payload)
    VALUES (
      v_reg.user_id,
      'refund_completed',
      'Refund Completed',
      'Your refund of ₹' || (v_refund_amount::NUMERIC / 100)::TEXT || ' has been sent to your UPI.',
      jsonb_build_object(
        'type', 'event',
        'id', v_reg.event_id,
        'payment_id', p_payment_id,
        'amount', v_refund_amount,
        'settlement', 'manual_offline'
      )
    );
  END IF;

  -- 16. Audit with full structured evidence.
  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('offline_manual_settlement', p_payment_id,
    jsonb_build_object(
      'admin_id', p_admin_id,
      'payment_id', p_payment_id,
      'task_id', v_task.id,
      'settle_id', v_settle_id,
      'amount', v_refund_amount,
      'sale_id', v_sale.id,
      'refund_row_id', v_refund_row_id,
      'evidence', p_evidence,
      'wallet_already_debited', v_wallet_already_debited,
      'clawback_state', v_clawback_state
    ));

  RETURN jsonb_build_object(
    'ok', true,
    'payment_id', p_payment_id,
    'settle_id', v_settle_id,
    'amount', v_refund_amount,
    'clawback_state', v_clawback_state
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_manual_settle_payment(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_manual_settle_payment(UUID, UUID, JSONB)
  TO authenticated, service_role;
