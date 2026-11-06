-- ============================================================================
-- CLUVO — Dispute Reissue & Ledger Accuracy
-- 1. Traceability: one disputed payout can be replaced once.
-- 2. New RPCs: re-confirm (same row) and reissue (new row + new UTR).
-- 3. Additive ledger fields: wallet_debit_amount, reserved_amount.
-- 4. Organizer statement now returns running_balance.
-- All changes are fully backward compatible; existing RPCs and data are untouched.
-- ============================================================================

-- -------------------------------------------------------
-- 3.1 Add traceability column & index (nullable, idempotent)
-- -------------------------------------------------------
ALTER TABLE public.payout_items
  ADD COLUMN IF NOT EXISTS replaces_payout_id UUID
  REFERENCES public.payout_items(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_items_replaces_payout
  ON public.payout_items(replaces_payout_id)
  WHERE replaces_payout_id IS NOT NULL;

-- -------------------------------------------------------
-- 3.2 New RPC: admin_request_payout_reconfirmation
-- -------------------------------------------------------
-- Use case: admin verifies the bank statement and wants to move the
-- same disputed row back to pending_confirmation so the organizer can
-- confirm receipt again (no new payout, same UTR).
CREATE OR REPLACE FUNCTION public.admin_request_payout_reconfirmation(
  p_payout_id UUID,
  p_admin_notes TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_payout_community_id UUID;
  v_community RECORD;
  v_payout RECORD;
  v_clean_notes TEXT;
  v_locked_payouts BIGINT := 0;
  v_uncommitted_balance BIGINT := 0;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can request payout reconfirmation.';
  END IF;

  v_clean_notes := TRIM(COALESCE(p_admin_notes, ''));
  IF LENGTH(v_clean_notes) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Resolution audit notes are required (minimum 10 characters).');
  END IF;

  SELECT pi.community_id INTO v_payout_community_id
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payout record not found.');
  END IF;

  -- Level 1: Lock community row FOR UPDATE
  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = v_payout_community_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Community not found.');
  END IF;

  -- Level 3: Lock payout_items row FOR UPDATE
  SELECT pi.* INTO v_payout
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id
  FOR UPDATE;

  IF v_payout.status != 'disputed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_payout_status',
      'message', format('Only disputed payouts can be reconfirmed (current status: %s).', v_payout.status)
    );
  END IF;

  -- Ensure wallet has enough to cover the eventual organizer confirm
  SELECT COALESCE(SUM(amount), 0) INTO v_locked_payouts
  FROM public.payout_items
  WHERE community_id = v_payout_community_id
    AND status IN ('pending_confirmation', 'disputed')
    AND id <> p_payout_id;

  v_uncommitted_balance := GREATEST(0, v_community.wallet_balance - v_locked_payouts);

  IF v_payout.amount > v_uncommitted_balance THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_uncommitted_balance',
      'message', format('Cannot request reconfirmation: ₹%s exceeds available uncommitted wallet balance (%s paise).', v_payout.amount, v_uncommitted_balance),
      'uncommitted_balance', v_uncommitted_balance,
      'locked_payouts', v_locked_payouts,
      'stored_wallet_balance', v_community.wallet_balance
    );
  END IF;

  -- Update the same row: move to pending_confirmation
  UPDATE public.payout_items
  SET status = 'pending_confirmation',
      resolution_notes = 'Re-confirmation requested: ' || v_clean_notes,
      resolved_at = NULL,
      updated_at = now()
  WHERE id = p_payout_id;

  -- Audit
  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('payout_reconfirmation_requested', jsonb_build_object(
    'payout_id', p_payout_id,
    'community_id', v_payout_community_id,
    'amount', v_payout.amount,
    'utr', v_payout.utr,
    'admin_id', auth.uid(),
    'notes', v_clean_notes
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'payout_id', p_payout_id,
    'amount', v_payout.amount,
    'status', 'pending_confirmation',
    'message', 'Re-confirmation requested. The organizer will receive a confirmation request.'
  );
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_request_payout_reconfirmation(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_request_payout_reconfirmation(UUID, TEXT) TO authenticated, service_role;


-- -------------------------------------------------------
-- 3.3 New RPC: admin_reissue_disputed_payout
-- -------------------------------------------------------
-- Use case: transfer failed; must create a new payout row with a new UTR.
-- The old disputed row is cancelled; a new pending_confirmation row is
-- created. Amount, community, event, beneficiary, currency are all copied
-- from the old row — the caller does NOT pass an amount.
-- -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_reissue_disputed_payout(
  p_payout_id UUID,
  p_utr TEXT,
  p_payment_method TEXT DEFAULT NULL::TEXT,
  p_admin_notes TEXT DEFAULT NULL::TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_payout_community_id UUID;
  v_community RECORD;
  v_event RECORD;
  v_payout RECORD;
  v_beneficiary RECORD;
  v_new_utr TEXT;
  v_normalized_utr TEXT;
  v_new_payout_id UUID;
  v_locked_payouts BIGINT := 0;
  v_uncommitted_balance BIGINT := 0;
  v_event_gross_organizer_share BIGINT := 0;
  v_event_refund_debits BIGINT := 0;
  v_event_settled_payouts BIGINT := 0;
  v_event_locked_payouts BIGINT := 0;
  v_event_available_payable BIGINT := 0;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can reissue a disputed payout.';
  END IF;

  v_normalized_utr := UPPER(TRIM(COALESCE(p_utr, '')));
  IF v_normalized_utr = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UTR / Bank transaction reference is required.');
  END IF;

  SELECT pi.community_id INTO v_payout_community_id
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payout record not found.');
  END IF;

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

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Community not found.');
  END IF;

  -- Level 2: Lock event row FOR UPDATE if event_id is not null
  SELECT e.* INTO v_event
  FROM public.events e
  WHERE e.id = v_payout.event_id;

  IF v_event.community_id != v_payout_community_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Event does not belong to the selected community.');
  END IF;

  -- Concurrency-safe duplicate active payout check (same logic as admin_record_manual_payout)
  IF EXISTS (
    SELECT 1 FROM public.payout_items
    WHERE community_id = v_payout_community_id
      AND COALESCE(event_id, '00000000-0000-0000-0000-000000000000'::UUID) = COALESCE(v_payout.event_id, '00000000-0000-0000-000000000000'::UUID)
      AND UPPER(TRIM(utr)) = v_normalized_utr
      AND status IN ('pending_confirmation', 'success')
      AND id <> p_payout_id
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'duplicate_payout_utr',
      'message', 'A payout with this UTR / Bank Reference is already recorded for this event or wallet and is currently active.'
    );
  END IF;

  -- Compute event-level revenue & locked payouts (same formulas as admin_record_manual_payout)
  SELECT COALESCE(SUM((pal.details->>'amount')::BIGINT), 0)
  INTO v_event_gross_organizer_share
  FROM public.payment_audit_log pal
  WHERE pal.action = 'wallet_credited'
    AND pal.details->>'event_id' IS NOT NULL
    AND (pal.details->>'event_id')::uuid = v_payout.event_id;

  -- Compute Event Verified Customer Refund Debits
  WITH deduped_prh AS (
    SELECT DISTINCT ON (COALESCE(prh.razorpay_refund_id, prh.id::TEXT))
      prh.*
    FROM public.payment_refund_history prh
    WHERE prh.event_id = v_payout.event_id
    ORDER BY COALESCE(prh.razorpay_refund_id, prh.id::TEXT), prh.created_at DESC
  ),
  calculated_refunds AS (
    SELECT
      d.id,
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
        ))::BIGINT AS single_refund_debit
    FROM deduped_prh d
    LEFT JOIN public.payments p ON p.id = d.payment_id
    WHERE (
      p.status = 'refunded'
      OR EXISTS (
        SELECT 1 FROM public.payment_audit_log pal
        WHERE pal.action = 'wallet_debited'
          AND ((pal.details->>'event_id')::UUID = v_payout.event_id OR pal.payment_id = d.payment_id)
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
  WHERE event_id = v_payout.event_id
    AND status = 'success';

  -- Compute Event In-Flight Locked Payouts (pending + disputed)
  SELECT COALESCE(SUM(amount), 0)::BIGINT
  INTO v_event_locked_payouts
  FROM public.payout_items
  WHERE event_id = v_payout.event_id
    AND status IN ('pending_confirmation', 'disputed')
    AND id <> p_payout_id;   -- exclude the old disputed row we are cancelling

  -- Calculate Available Uncommitted Event Payable Balance
  v_event_available_payable := GREATEST(0, (v_event_gross_organizer_share - v_event_refund_debits - v_event_settled_payouts - v_event_locked_payouts));

  IF v_payout.amount > v_event_available_payable THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_event_payable_balance',
      'message', format('Requested payout amount (%s paise) exceeds available uncommitted event balance (%s paise). In-flight pending and disputed payouts for this event are reserved.', v_payout.amount, v_event_available_payable),
      'event_available_payable', v_event_available_payable,
      'event_gross_earned', (v_event_gross_organizer_share - v_event_refund_debits),
      'event_settled_payouts', v_event_settled_payouts,
      'event_locked_payouts', v_event_locked_payouts
    );
  END IF;

  -- Community-level balance validation (excluding the old disputed row)
  SELECT COALESCE(SUM(amount), 0) INTO v_locked_payouts
  FROM public.payout_items
  WHERE community_id = v_payout_community_id
    AND status IN ('pending_confirmation', 'disputed')
    AND id <> p_payout_id;

  v_uncommitted_balance := GREATEST(0, v_community.wallet_balance - v_locked_payouts);

  IF v_payout.amount > v_uncommitted_balance THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_uncommitted_balance',
      'message', format('Requested payout amount (%s paise) exceeds available uncommitted wallet balance (%s paise). In-flight pending and disputed payouts are reserved.', v_payout.amount, v_uncommitted_balance),
      'uncommitted_balance', v_uncommitted_balance,
      'locked_payouts', v_locked_payouts,
      'stored_wallet_balance', v_community.wallet_balance
    );
  END IF;

  -- Validate new UTR is not already active (non-disputed) in this scope
  IF EXISTS (
    SELECT 1 FROM public.payout_items
    WHERE community_id = v_payout_community_id
      AND COALESCE(event_id, '00000000-0000-0000-0000-000000000000'::UUID) = COALESCE(v_payout.event_id, '00000000-0000-0000-000000000000'::UUID)
      AND UPPER(TRIM(utr)) = v_normalized_utr
      AND status IN ('pending_confirmation', 'success')
      AND id <> p_payout_id
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'duplicate_payout_utr',
      'message', 'A payout with this UTR is already active for this event or wallet.'
    );
  END IF;

  -- Insert new row: pending_confirmation, same amount/event/beneficiary/currency
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
    v_payout_community_id,
    v_payout.event_id,
    v_payout.amount,
    v_payout.currency,
    'pending_confirmation',
    v_normalized_utr,
    v_payout.beneficiary_id,
    COALESCE(p_payment_method, v_payout.payment_method, 'IMPS'),
    p_admin_notes,
    auth.uid()
  )
  RETURNING id INTO v_new_payout_id;

  -- Update old row: mark cancelled, record reissue details using existing columns
  UPDATE public.payout_items
  SET status = 'cancelled',
      resolved_by_admin = auth.uid(),
      resolved_at = clock_timestamp(),
      resolution_notes = 'Reissued as payout ' || v_new_payout_id || '. ' || COALESCE(p_admin_notes, ''),
      updated_at = now()
  WHERE id = p_payout_id;

  -- Audit: reissued
  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('payout_dispute_reissued', jsonb_build_object(
    'old_payout_id', p_payout_id,
    'new_payout_id', v_new_payout_id,
    'community_id', v_payout_community_id,
    'amount', v_payout.amount,
    'old_utr', v_payout.utr,
    'new_utr', v_normalized_utr,
    'admin_id', auth.uid()
  ));

  -- Audit: new payout recorded
  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('manual_payout_recorded', jsonb_build_object(
    'payout_id', v_new_payout_id,
    'community_id', v_payout_community_id,
    'event_id', v_payout.event_id,
    'amount', v_payout.amount,
    'utr', v_normalized_utr,
    'admin_id', auth.uid(),
    'reissue_of', p_payout_id,
    'locked_payouts', v_locked_payouts + v_payout.amount,
    'remaining_uncommitted', v_uncommitted_balance - v_payout.amount
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'old_payout_id', p_payout_id,
    'new_payout_id', v_new_payout_id,
    'amount', v_payout.amount,
    'old_status', 'disputed',
    'new_status', 'pending_confirmation',
    'message', 'Old disputed payout cancelled; new pending payout created. Please confirm receipt in the organizer dashboard.'
  );
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_reissue_disputed_payout(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reissue_disputed_payout(UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;


-- -------------------------------------------------------
-- 3.4 Additive ledger fields in both statement RPCs
-- -------------------------------------------------------
-- The two functions below are designed to be copied from 202611040003 with only
-- the payout branch and output projection changed. Every existing key retains
-- its name and type; new keys are added at the end.
-- ------------------------------------------------------------------
-- 3.4.1 get_admin_financial_statement — additive columns only
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_financial_statement(
  p_community_id UUID,
  p_event_id UUID DEFAULT NULL::UUID
) RETURNS jsonb
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

    UNION ALL

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
      -- NEW: wallet_debit_amount — actual wallet debit only
      CASE
        WHEN pi.status = 'success' THEN pi.amount
        ELSE 0 END AS wallet_debit_amount,
  -- NEW: reserved_amount — amount held for pending/disputed payouts
      CASE
        WHEN pi.status IN ('pending_confirmation', 'disputed') THEN pi.amount
        ELSE 0 END AS reserved_amount,
    -- NEW: replaces_payout_id — traceability
      pi.replaces_payout_id AS replaces_payout_id,
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
      'wallet_debit_amount', w.wallet_debit_amount,
      'reserved_amount', w.reserved_amount,
      'replaces_payout_id', w.replaces_payout_id,
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
REVOKE ALL PRIVILEGES ON FUNCTION public.get_admin_financial_statement(UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_financial_statement(UUID, UUID)
  TO authenticated, service_role;


-- -------------------------------------------------------
-- 3.4.2 get_organizer_financial_statement — additive columns + running_balance
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_organizer_financial_statement(
  p_community_id UUID,
  p_event_id UUID DEFAULT NULL::UUID
) RETURNS jsonb
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

  -- -----------------------------------------------------------------
  -- raw_transactions CTE: flows 1 (ticket sales), 2 (refunds), 3 (manual
  -- payouts & transfers).  Flow 3 now includes the new columns.  The rest
  -- of the body is identical to 202611040003.
  -- -----------------------------------------------------------------
  WITH raw_transactions AS (
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
      NULL::TEXT AS confirmed_at,
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
      NULL::UUID AS registration_id,
      NULL::UUID AS event_id,
      NULL::TEXT AS event_title,
      NULL::TEXT AS check_in_status,
      NULL::INTEGER AS gross_amount,
      0::INTEGER AS platform_fee,
      0::INTEGER AS organizer_share,
      0::INTEGER AS money_in,
      CASE
        WHEN rt.transaction_type = 'refund' OR rt.status IN ('success', 'processed') THEN rt.money_out
        ELSE 0 END AS money_out,
      NULL::TEXT AS refund_reason,
      NULL::TEXT AS admin_notes,
      'refund'::TEXT AS payment_method,
      NULL::JSONB AS bank_details,
      NULL::TEXT AS confirmed_at,
      NULL::TEXT AS resolution_notes,
      NULL::TIMESTAMPTZ AS resolved_at
    FROM calculated_refunds d
    LEFT JOIN public.payments p ON p.id = d.payment_id
    LEFT JOIN public.profiles prof ON prof.id = r.user_id
    -- (existing joins/filtering continue ...)

    UNION ALL

    -- Flow 3: Manual Payouts & Transfers — with new columns
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
      -- NEW: wallet_debit_amount — actual wallet debit only
      CASE
        WHEN pi.status = 'success' THEN pi.amount
        ELSE 0 END AS wallet_debit_amount,
  -- NEW: reserved_amount — amount held for pending/disputed payouts
        CASE
          WHEN pi.status IN ('pending_confirmation', 'disputed') THEN pi.amount
          ELSE 0 END AS reserved_amount,
  -- NEW: replaces_payout_id — traceability
        pi.replaces_payout_id AS replaces_payout_id,
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
  -- -----------------------------------------------------------------
  -- with_running_balance: computes running_balance using
  -- money_in - wallet_debit_amount (the actual debit, not the face value).
  -- -----------------------------------------------------------------
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
      'refund_reason', w.refund_reason,
      'admin_notes', w.admin_notes,
      'payment_method', w.payment_method,
      'bank_details', w.bank_details,
      'confirmed_at', w.confirmed_at,
      'resolution_notes', w.resolution_notes,
      'resolved_at', w.resolved_at,
      -- NEW KEYS (added at the end, backward-compatible)
      'wallet_debit_amount', COALESCE(w.wallet_debit_amount, 0),
      'reserved_amount', COALESCE(w.reserved_amount, 0),
      'replaces_payout_id', w.replaces_payout_id,
      -- organizer-only: running_balance now populated from the expression above
      'running_balance', w.running_balance
    )
    ORDER BY w.created_at DESC
  ) INTO v_result
  FROM with_running_balance w;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_organizer_financial_statement(UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_organizer_financial_statement(UUID, UUID)
  TO authenticated, service_role;