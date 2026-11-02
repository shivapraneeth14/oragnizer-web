-- ============================================================================
-- CLUVO STAGE 6 REMEDIATION — MIGRATION 202611010017
-- Concurrency-Safe Manual Settlements, Dispute Resolution, and Event Limits
--
-- 1. Extend payout_items with resolution auditing columns.
-- 2. Deploy hardened organizer_confirm_manual_payout with two-tier row locking.
-- 3. Deploy hardened organizer_dispute_manual_payout with coordinated locking.
-- 4. Deploy admin_resolve_payout_dispute RPC (cancel vs confirm-received).
-- 5. Deploy admin_cancel_manual_payout RPC for unconfirmed pending settlements.
-- 6. Deploy hardened admin_record_manual_payout with event-level revenue limit checks.
-- 7. Update get_admin_financial_statement and get_organizer_financial_statement to surface resolution details.
-- ============================================================================

-- 1. Extend payout_items with dispute resolution columns
ALTER TABLE public.payout_items
  ADD COLUMN IF NOT EXISTS resolved_by_admin UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

-- 2. Concurrency-Safe organizer_confirm_manual_payout
CREATE OR REPLACE FUNCTION public.organizer_confirm_manual_payout(
  p_payout_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payout_community_id UUID;
  v_payout RECORD;
  v_community RECORD;
  v_new_balance INTEGER;
BEGIN
  -- Initial existence lookup without locks
  SELECT pi.community_id INTO v_payout_community_id
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payout record not found.');
  END IF;

  -- Authorization check
  IF NOT (public.is_community_owner(v_payout_community_id) OR public.is_admin_user()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not authorized to confirm this payout.');
  END IF;

  -- GLOBAL LOCK HIERARCHY:
  -- Level 1: Lock community row FOR UPDATE
  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = v_payout_community_id
  FOR UPDATE;

  -- Level 3: Lock payout_items row FOR UPDATE
  SELECT pi.* INTO v_payout
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id
  FOR UPDATE;

  -- Strict status re-verification under exclusive lock
  IF v_payout.status != 'pending_confirmation' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_payout_status',
      'message', format('Payout is no longer pending confirmation (current status: %s).', v_payout.status)
    );
  END IF;

  IF v_community.wallet_balance < v_payout.amount THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Insufficient community wallet balance.');
  END IF;

  -- Atomic wallet balance debit
  UPDATE public.communities
  SET wallet_balance = wallet_balance - v_payout.amount
  WHERE id = v_payout_community_id
  RETURNING wallet_balance INTO v_new_balance;

  -- Atomic payout status transition
  UPDATE public.payout_items
  SET status = 'success',
      confirmed_by_user = auth.uid(),
      confirmed_at = clock_timestamp()
  WHERE id = p_payout_id;

  -- Append to immutable audit log
  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('wallet_debited', jsonb_build_object(
    'community_id', v_payout_community_id,
    'amount', v_payout.amount,
    'new_balance', v_new_balance,
    'reason', 'Manual payout confirmed: ' || COALESCE(v_payout.utr, ''),
    'payout_id', p_payout_id,
    'event_id', v_payout.event_id,
    'confirmed_by', auth.uid()
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'payout_id', p_payout_id,
    'amount', v_payout.amount,
    'new_balance', v_new_balance,
    'status', 'success'
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.organizer_confirm_manual_payout(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.organizer_confirm_manual_payout(UUID) TO authenticated, service_role;

-- 3. Concurrency-Safe organizer_dispute_manual_payout
CREATE OR REPLACE FUNCTION public.organizer_dispute_manual_payout(
  p_payout_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payout_community_id UUID;
  v_payout RECORD;
BEGIN
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A reason is required to dispute a payout.');
  END IF;

  SELECT pi.community_id INTO v_payout_community_id
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payout record not found.');
  END IF;

  IF NOT (public.is_community_owner(v_payout_community_id) OR public.is_admin_user()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not authorized to dispute this payout.');
  END IF;

  -- GLOBAL LOCK HIERARCHY:
  -- Level 1: Lock community row FOR UPDATE
  PERFORM 1 FROM public.communities c
  WHERE c.id = v_payout_community_id
  FOR UPDATE;

  -- Level 3: Lock payout_items row FOR UPDATE
  SELECT pi.* INTO v_payout
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id
  FOR UPDATE;

  -- Strict status re-verification under exclusive lock
  IF v_payout.status != 'pending_confirmation' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_payout_status',
      'message', format('Only payouts in pending confirmation state can be disputed (current status: %s).', v_payout.status)
    );
  END IF;

  -- Transition status to disputed without altering wallet_balance
  UPDATE public.payout_items
  SET status = 'disputed',
      dispute_reason = TRIM(p_reason),
      confirmed_by_user = auth.uid(),
      confirmed_at = clock_timestamp()
  WHERE id = p_payout_id;

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('payout_disputed', jsonb_build_object(
    'payout_id', p_payout_id,
    'community_id', v_payout_community_id,
    'event_id', v_payout.event_id,
    'amount', v_payout.amount,
    'utr', v_payout.utr,
    'dispute_reason', TRIM(p_reason),
    'user_id', auth.uid()
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'payout_id', p_payout_id,
    'amount', v_payout.amount,
    'status', 'disputed'
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.organizer_dispute_manual_payout(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.organizer_dispute_manual_payout(UUID, TEXT) TO authenticated, service_role;

-- 4. Admin Dispute Resolution RPC
CREATE OR REPLACE FUNCTION public.admin_resolve_payout_dispute(
  p_payout_id UUID,
  p_resolution TEXT,
  p_resolution_notes TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payout_community_id UUID;
  v_payout RECORD;
  v_community RECORD;
  v_new_balance INTEGER;
  v_clean_notes TEXT;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can resolve payout disputes.';
  END IF;

  v_clean_notes := TRIM(COALESCE(p_resolution_notes, ''));
  IF LENGTH(v_clean_notes) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Resolution audit notes are required (minimum 10 characters).');
  END IF;

  IF p_resolution NOT IN ('cancel_disputed_payout', 'confirm_received_payout') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid resolution action. Must be cancel_disputed_payout or confirm_received_payout.');
  END IF;

  SELECT pi.community_id INTO v_payout_community_id
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payout record not found.');
  END IF;

  -- Level 1: Lock community row
  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = v_payout_community_id
  FOR UPDATE;

  -- Level 3: Lock payout_items row
  SELECT pi.* INTO v_payout
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id
  FOR UPDATE;

  IF v_payout.status != 'disputed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_payout_status',
      'message', format('Only disputed payouts can be resolved through this procedure (current status: %s).', v_payout.status)
    );
  END IF;

  IF p_resolution = 'cancel_disputed_payout' THEN
    -- Resolution A: Cancel disputed payout, unreserve funds, zero wallet debit
    UPDATE public.payout_items
    SET status = 'cancelled',
        resolved_by_admin = auth.uid(),
        resolved_at = clock_timestamp(),
        resolution_notes = v_clean_notes
    WHERE id = p_payout_id;

    INSERT INTO public.payment_audit_log (action, details)
    VALUES ('payout_dispute_cancelled', jsonb_build_object(
      'payout_id', p_payout_id,
      'community_id', v_payout_community_id,
      'event_id', v_payout.event_id,
      'amount', v_payout.amount,
      'utr', v_payout.utr,
      'admin_id', auth.uid(),
      'original_dispute_reason', v_payout.dispute_reason,
      'resolution_notes', v_clean_notes
    ));

    RETURN jsonb_build_object(
      'ok', true,
      'payout_id', p_payout_id,
      'status', 'cancelled',
      'unreserved_amount', v_payout.amount,
      'message', 'Disputed settlement cancelled. Reserved balance successfully released.'
    );

  ELSIF p_resolution = 'confirm_received_payout' THEN
    -- Resolution B: Payout verified as received by organizer, debit wallet exactly once
    IF v_community.wallet_balance < v_payout.amount THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Insufficient community wallet balance to confirm settlement.');
    END IF;

    UPDATE public.communities
    SET wallet_balance = wallet_balance - v_payout.amount
    WHERE id = v_payout_community_id
    RETURNING wallet_balance INTO v_new_balance;

    UPDATE public.payout_items
    SET status = 'success',
        resolved_by_admin = auth.uid(),
        resolved_at = clock_timestamp(),
        resolution_notes = v_clean_notes,
        confirmed_at = COALESCE(confirmed_at, clock_timestamp())
    WHERE id = p_payout_id;

    INSERT INTO public.payment_audit_log (action, details)
    VALUES ('wallet_debited', jsonb_build_object(
      'community_id', v_payout_community_id,
      'amount', v_payout.amount,
      'new_balance', v_new_balance,
      'reason', 'Dispute resolved as received: ' || v_clean_notes,
      'payout_id', p_payout_id,
      'event_id', v_payout.event_id,
      'admin_id', auth.uid(),
      'resolution_type', 'dispute_resolved'
    ));

    RETURN jsonb_build_object(
      'ok', true,
      'payout_id', p_payout_id,
      'status', 'success',
      'new_balance', v_new_balance,
      'message', 'Settlement confirmed as received. Community wallet debited.'
    );
  END IF;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_resolve_payout_dispute(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_payout_dispute(UUID, TEXT, TEXT) TO authenticated, service_role;

-- 5. Admin Cancellation for Unconfirmed Pending Settlements
CREATE OR REPLACE FUNCTION public.admin_cancel_manual_payout(
  p_payout_id UUID,
  p_cancel_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payout_community_id UUID;
  v_payout RECORD;
  v_clean_reason TEXT;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can cancel manual payouts.';
  END IF;

  v_clean_reason := TRIM(COALESCE(p_cancel_reason, ''));
  IF LENGTH(v_clean_reason) < 5 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cancellation reason is required (minimum 5 characters).');
  END IF;

  SELECT pi.community_id INTO v_payout_community_id
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payout record not found.');
  END IF;

  -- Level 1: Lock community row
  PERFORM 1 FROM public.communities c
  WHERE c.id = v_payout_community_id
  FOR UPDATE;

  -- Level 3: Lock payout_items row
  SELECT pi.* INTO v_payout
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id
  FOR UPDATE;

  IF v_payout.status != 'pending_confirmation' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_payout_status',
      'message', format('Only pending settlements can be cancelled via this procedure (current status: %s). Use dispute resolution for disputed records.', v_payout.status)
    );
  END IF;

  UPDATE public.payout_items
  SET status = 'cancelled',
      resolved_by_admin = auth.uid(),
      resolved_at = clock_timestamp(),
      resolution_notes = v_clean_reason
  WHERE id = p_payout_id;

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('manual_payout_cancelled', jsonb_build_object(
    'payout_id', p_payout_id,
    'community_id', v_payout_community_id,
    'event_id', v_payout.event_id,
    'amount', v_payout.amount,
    'utr', v_payout.utr,
    'admin_id', auth.uid(),
    'reason', v_clean_reason
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'payout_id', p_payout_id,
    'status', 'cancelled',
    'unreserved_amount', v_payout.amount,
    'message', 'Pending settlement cancelled. Reserved balance released.'
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_cancel_manual_payout(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_cancel_manual_payout(UUID, TEXT) TO authenticated, service_role;

-- 6. Hardened admin_record_manual_payout with Event-Level Revenue Limit Enforcement
CREATE OR REPLACE FUNCTION public.admin_record_manual_payout(
  p_community_id UUID,
  p_amount INTEGER,
  p_utr TEXT,
  p_payment_method TEXT DEFAULT 'IMPS',
  p_event_id UUID DEFAULT NULL,
  p_admin_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_community RECORD;
  v_event RECORD;
  v_beneficiary RECORD;
  v_payout_id UUID;
  v_normalized_utr TEXT;
  v_locked_payouts BIGINT := 0;
  v_uncommitted_balance BIGINT := 0;

  -- Event-level limits
  v_event_gross_organizer_share BIGINT := 0;
  v_event_refund_debits BIGINT := 0;
  v_event_settled_payouts BIGINT := 0;
  v_event_locked_payouts BIGINT := 0;
  v_event_available_payable BIGINT := 0;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can record manual payouts.';
  END IF;

  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payout amount must be greater than zero.');
  END IF;

  v_normalized_utr := UPPER(TRIM(COALESCE(p_utr, '')));
  IF v_normalized_utr = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UTR / Bank transaction reference is required.');
  END IF;

  -- Concurrency-safe duplicate active payout check
  IF EXISTS (
    SELECT 1 FROM public.payout_items
    WHERE community_id = p_community_id
      AND COALESCE(event_id, '00000000-0000-0000-0000-000000000000'::UUID) = COALESCE(p_event_id, '00000000-0000-0000-0000-000000000000'::UUID)
      AND UPPER(TRIM(utr)) = v_normalized_utr
      AND status IN ('pending_confirmation', 'success')
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'duplicate_payout_utr',
      'message', 'A payout with this UTR / Bank Reference is already recorded for this event or wallet and is currently active.'
    );
  END IF;

  -- GLOBAL LOCK HIERARCHY:
  -- Level 1: Lock community row FOR UPDATE
  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = p_community_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Community not found.');
  END IF;

  -- Level 2: Lock event row FOR UPDATE if event attribution is provided
  IF p_event_id IS NOT NULL THEN
    SELECT e.* INTO v_event
    FROM public.events e
    WHERE e.id = p_event_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Event not found.');
    END IF;

    IF v_event.community_id != p_community_id THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Event does not belong to the selected community.');
    END IF;

    -- Compute Event Gross Organizer Sales Earned
    SELECT COALESCE(SUM(COALESCE(p.organizer_share, GREATEST(p.amount - COALESCE(p.platform_fee, 0), 0))), 0)::BIGINT
    INTO v_event_gross_organizer_share
    FROM public.payments p
    JOIN public.registrations r ON r.id = p.registration_id
    WHERE r.event_id = p_event_id
      AND ((p.status = 'success' AND r.status IN ('confirmed', 'attended')) OR p.status = 'refunded');

    -- Compute Event Verified Customer Refund Debits
    WITH deduped_prh AS (
      SELECT DISTINCT ON (COALESCE(prh.razorpay_refund_id, prh.id::TEXT))
        prh.*
      FROM public.payment_refund_history prh
      WHERE prh.event_id = p_event_id
      ORDER BY COALESCE(prh.razorpay_refund_id, prh.id::TEXT), prh.created_at DESC
    ),
    calculated_refunds AS (
      SELECT
        d.id,
        GREATEST(0, LEAST(
          CASE 
            WHEN d.refund_reason = 'event_cancellation' 
            THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
            ELSE d.amount
          END,
          COALESCE(p.organizer_share, GREATEST(COALESCE(d.payment_amount, p.amount, d.amount) - COALESCE(d.platform_fee, p.platform_fee, 0), 0))
          - COALESCE(SUM(
              CASE 
                WHEN d.refund_reason = 'event_cancellation' 
                THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
                ELSE d.amount
              END
            ) OVER (
              PARTITION BY d.payment_id 
              ORDER BY d.created_at, d.id 
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ), 0)
        ))::BIGINT AS single_refund_debit
      FROM deduped_prh d
      LEFT JOIN public.payments p ON p.id = d.payment_id
      WHERE (
        p.status = 'refunded'
        OR EXISTS (
          SELECT 1 FROM public.payment_audit_log pal
          WHERE pal.action = 'wallet_debited'
            AND ((pal.details->>'event_id')::UUID = p_event_id OR pal.payment_id = d.payment_id)
        )
      )
    )
    SELECT COALESCE(SUM(single_refund_debit), 0)::BIGINT
    INTO v_event_refund_debits
    FROM calculated_refunds;

    -- Compute Event Settled Payouts
    SELECT COALESCE(SUM(amount), 0)::BIGINT
    INTO v_event_settled_payouts
    FROM public.payout_items
    WHERE event_id = p_event_id
      AND status = 'success';

    -- Compute Event In-Flight Locked Payouts (pending + disputed)
    SELECT COALESCE(SUM(amount), 0)::BIGINT
    INTO v_event_locked_payouts
    FROM public.payout_items
    WHERE event_id = p_event_id
      AND status IN ('pending_confirmation', 'disputed');

    -- Calculate Available Uncommitted Event Payable Balance
    v_event_available_payable := GREATEST(0, (v_event_gross_organizer_share - v_event_refund_debits - v_event_settled_payouts - v_event_locked_payouts));

    IF p_amount > v_event_available_payable THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'insufficient_event_payable_balance',
        'message', format('Requested payout amount (%s paise) exceeds available uncommitted event balance (%s paise). In-flight pending and disputed payouts for this event are reserved.', p_amount, v_event_available_payable),
        'event_available_payable', v_event_available_payable,
        'event_gross_earned', (v_event_gross_organizer_share - v_event_refund_debits),
        'event_settled_payouts', v_event_settled_payouts,
        'event_locked_payouts', v_event_locked_payouts
      );
    END IF;
  END IF;

  -- Community-level balance validation
  SELECT COALESCE(SUM(amount), 0) INTO v_locked_payouts
  FROM public.payout_items
  WHERE community_id = p_community_id
    AND status IN ('pending_confirmation', 'disputed');

  v_uncommitted_balance := GREATEST(0, v_community.wallet_balance - v_locked_payouts);

  IF p_amount > v_uncommitted_balance THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_uncommitted_balance',
      'message', format('Requested payout amount (%s paise) exceeds available uncommitted wallet balance (%s paise). In-flight pending and disputed payouts are reserved.', p_amount, v_uncommitted_balance),
      'uncommitted_balance', v_uncommitted_balance,
      'locked_payouts', v_locked_payouts,
      'stored_wallet_balance', v_community.wallet_balance
    );
  END IF;

  SELECT cb.* INTO v_beneficiary
  FROM public.community_beneficiaries cb
  WHERE cb.community_id = p_community_id
    AND cb.is_active = true
  LIMIT 1;

  INSERT INTO public.payout_items (
    community_id,
    event_id,
    amount,
    currency,
    status,
    utr,
    beneficiary_id,
    payment_method,
    admin_notes,
    recorded_by_admin
  )
  VALUES (
    p_community_id,
    p_event_id,
    p_amount,
    'INR',
    'pending_confirmation',
    v_normalized_utr,
    v_beneficiary.id,
    p_payment_method,
    p_admin_notes,
    auth.uid()
  )
  RETURNING id INTO v_payout_id;

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('manual_payout_recorded', jsonb_build_object(
    'payout_id', v_payout_id,
    'community_id', p_community_id,
    'event_id', p_event_id,
    'amount', p_amount,
    'utr', v_normalized_utr,
    'admin_id', auth.uid(),
    'locked_payouts', v_locked_payouts + p_amount,
    'remaining_uncommitted', v_uncommitted_balance - p_amount
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'payout_id', v_payout_id,
    'amount', p_amount,
    'status', 'pending_confirmation',
    'uncommitted_balance', (v_uncommitted_balance - p_amount)
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_record_manual_payout(UUID, INTEGER, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_record_manual_payout(UUID, INTEGER, TEXT, TEXT, UUID, TEXT) TO authenticated, service_role;

-- 7. Update get_admin_financial_statement to map cancelled settlements and surface resolution details
CREATE OR REPLACE FUNCTION public.get_admin_financial_statement(
  p_community_id UUID,
  p_event_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
        CASE 
          WHEN d.refund_reason = 'event_cancellation' 
          THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
          ELSE d.amount
        END,
        COALESCE(p.organizer_share, GREATEST(COALESCE(d.payment_amount, p.amount, d.amount) - COALESCE(d.platform_fee, p.platform_fee, 0), 0))
        - COALESCE(SUM(
            CASE 
              WHEN d.refund_reason = 'event_cancellation' 
              THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
              ELSE d.amount
            END
          ) OVER (
            PARTITION BY d.payment_id 
            ORDER BY d.created_at, d.id 
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::INTEGER AS organizer_share,
      0::INTEGER AS money_in,
      GREATEST(0, LEAST(
        CASE 
          WHEN d.refund_reason = 'event_cancellation' 
          THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
          ELSE d.amount
        END,
        COALESCE(p.organizer_share, GREATEST(COALESCE(d.payment_amount, p.amount, d.amount) - COALESCE(d.platform_fee, p.platform_fee, 0), 0))
        - COALESCE(SUM(
            CASE 
              WHEN d.refund_reason = 'event_cancellation' 
              THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
              ELSE d.amount
            END
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
      COALESCE(p.organizer_share, GREATEST(p.amount - COALESCE(p.platform_fee, 0), 0)) AS organizer_share,
      COALESCE(p.organizer_share, GREATEST(p.amount - COALESCE(p.platform_fee, 0), 0)) AS money_in,
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
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_admin_financial_statement(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_financial_statement(UUID, UUID) TO authenticated, service_role;

-- 8. Update get_organizer_financial_statement to map cancelled settlements and surface resolution details
CREATE OR REPLACE FUNCTION public.get_organizer_financial_statement(
  p_community_id UUID,
  p_event_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
        CASE 
          WHEN d.refund_reason = 'event_cancellation' 
          THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
          ELSE d.amount
        END,
        COALESCE(p.organizer_share, GREATEST(COALESCE(d.payment_amount, p.amount, d.amount) - COALESCE(d.platform_fee, p.platform_fee, 0), 0))
        - COALESCE(SUM(
            CASE 
              WHEN d.refund_reason = 'event_cancellation' 
              THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
              ELSE d.amount
            END
          ) OVER (
            PARTITION BY d.payment_id 
            ORDER BY d.created_at, d.id 
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)
      ))::INTEGER AS organizer_share,
      0::INTEGER AS money_in,
      GREATEST(0, LEAST(
        CASE 
          WHEN d.refund_reason = 'event_cancellation' 
          THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
          ELSE d.amount
        END,
        COALESCE(p.organizer_share, GREATEST(COALESCE(d.payment_amount, p.amount, d.amount) - COALESCE(d.platform_fee, p.platform_fee, 0), 0))
        - COALESCE(SUM(
            CASE 
              WHEN d.refund_reason = 'event_cancellation' 
              THEN GREATEST(d.amount - COALESCE(d.platform_fee, p.platform_fee, 0), 0)
              ELSE d.amount
            END
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
      COALESCE(p.organizer_share, GREATEST(p.amount - COALESCE(p.platform_fee, 0), 0)) AS organizer_share,
      COALESCE(p.organizer_share, GREATEST(p.amount - COALESCE(p.platform_fee, 0), 0)) AS money_in,
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
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_organizer_financial_statement(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_organizer_financial_statement(UUID, UUID) TO authenticated, service_role;
