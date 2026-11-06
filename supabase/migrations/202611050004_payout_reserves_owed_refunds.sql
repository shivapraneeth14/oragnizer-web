-- ============================================================================
-- CLUVO — Payouts must reserve refunds that are still owed.
--
-- A refund that is claimed / pending / failed is still owed to the customer.
-- The money is sitting in the organizer wallet until Razorpay (or a manual
-- settlement) completes, so the payout screens must NOT treat it as payable.
--
-- Available payable now subtracts:
--   completed refunds (legacy + processed history)  AND
--   open refund debt (payments.refund_amount_due > 0)
-- capped at the organizer share of that sale (never deduct money the organizer
-- never received). No payout is blocked — the payable amount is just smaller.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_record_manual_payout(
  p_community_id uuid,
  p_amount integer,
  p_utr text,
  p_payment_method text DEFAULT 'IMPS'::text,
  p_event_id uuid DEFAULT NULL::uuid,
  p_admin_notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
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
  v_event_open_refunds BIGINT := 0;
  v_event_settled_payouts BIGINT := 0;
  v_event_locked_payouts BIGINT := 0;
  v_event_available_payable BIGINT := 0;

  -- Community-level reserved refund debt
  v_community_open_refunds BIGINT := 0;
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

  -- GLOBAL LOCK HIERARCHY: Level 1 community, Level 2 event.
  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = p_community_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Community not found.');
  END IF;

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

    SELECT COALESCE(SUM((pal.details->>'amount')::BIGINT), 0)
    INTO v_event_gross_organizer_share
    FROM public.payment_audit_log pal
    WHERE pal.action = 'wallet_credited'
      AND pal.details->>'event_id' IS NOT NULL
      AND (pal.details->>'event_id')::uuid = p_event_id;

    -- Completed/legacy refund debits. Payments with an OPEN debt are excluded
    -- here and counted below from refund_amount_due, so each refund is counted
    -- exactly once (never both open and settled).
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
      -- Open debt is counted from refund_amount_due below.
      AND NOT (COALESCE(p.refund_amount_due, 0) > 0)
    )
    SELECT COALESCE(SUM(single_refund_debit), 0)::BIGINT
    INTO v_event_refund_debits
    FROM calculated_refunds;

    -- Refund debt still owed (claimed / pending / failed). Capped at the
    -- organizer share so we never deduct money the organizer never received.
    SELECT COALESCE(SUM(GREATEST(0, LEAST(
             GREATEST(COALESCE(p.organizer_share, 0), 0),
             GREATEST(COALESCE(p.refund_amount_due, 0), 0)
           ))), 0)::BIGINT
    INTO v_event_open_refunds
    FROM public.payments p
    JOIN public.registrations r ON r.id = p.registration_id
    WHERE r.event_id = p_event_id
      AND COALESCE(p.refund_amount_due, 0) > 0;

    v_event_refund_debits := v_event_refund_debits + v_event_open_refunds;

    SELECT COALESCE(SUM(amount), 0)::BIGINT
    INTO v_event_settled_payouts
    FROM public.payout_items
    WHERE event_id = p_event_id
      AND status = 'success';

    SELECT COALESCE(SUM(amount), 0)::BIGINT
    INTO v_event_locked_payouts
    FROM public.payout_items
    WHERE event_id = p_event_id
      AND status IN ('pending_confirmation', 'disputed');

    v_event_available_payable := GREATEST(0, (v_event_gross_organizer_share - v_event_refund_debits - v_event_settled_payouts - v_event_locked_payouts));

    IF p_amount > v_event_available_payable THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'insufficient_event_payable_balance',
        'message', format('Requested payout amount (%s paise) exceeds available uncommitted event balance (%s paise). In-flight payouts and refunds still owed to customers are reserved.', p_amount, v_event_available_payable),
        'event_available_payable', v_event_available_payable,
        'event_gross_earned', (v_event_gross_organizer_share - v_event_refund_debits),
        'event_refund_debits', v_event_refund_debits,
        'event_open_refunds', v_event_open_refunds,
        'event_settled_payouts', v_event_settled_payouts,
        'event_locked_payouts', v_event_locked_payouts
      );
    END IF;
  END IF;

  -- Community-level balance validation.
  SELECT COALESCE(SUM(amount), 0) INTO v_locked_payouts
  FROM public.payout_items
  WHERE community_id = p_community_id
    AND status IN ('pending_confirmation', 'disputed');

  -- Refund debt across the whole community is reserved too (covers the
  -- "Settle Entire Wallet" scope, which must not drain upcoming refunds).
  SELECT COALESCE(SUM(GREATEST(0, LEAST(
             GREATEST(COALESCE(p.organizer_share, 0), 0),
             GREATEST(COALESCE(p.refund_amount_due, 0), 0)
           ))), 0)::BIGINT
  INTO v_community_open_refunds
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  JOIN public.events e ON e.id = r.event_id
  WHERE e.community_id = p_community_id
    AND COALESCE(p.refund_amount_due, 0) > 0;

  v_uncommitted_balance := GREATEST(0, v_community.wallet_balance - v_locked_payouts - v_community_open_refunds);

  IF p_amount > v_uncommitted_balance THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_uncommitted_balance',
      'message', format('Requested payout amount (%s paise) exceeds available uncommitted wallet balance (%s paise). In-flight payouts and refunds still owed to customers are reserved.', p_amount, v_uncommitted_balance),
      'uncommitted_balance', v_uncommitted_balance,
      'locked_payouts', v_locked_payouts,
      'open_refund_liability', v_community_open_refunds,
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
    'open_refund_liability', v_community_open_refunds,
    'remaining_uncommitted', v_uncommitted_balance - p_amount
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'payout_id', v_payout_id,
    'amount', p_amount,
    'status', 'pending_confirmation',
    'open_refund_liability', v_community_open_refunds,
    'uncommitted_balance', (v_uncommitted_balance - p_amount)
  );
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_record_manual_payout(UUID, INTEGER, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_record_manual_payout(UUID, INTEGER, TEXT, TEXT, UUID, TEXT) TO authenticated, service_role;


-- ----------------------------------------------------------------------------
-- admin_reissue_disputed_payout — same owed-refund reservation.
-- ----------------------------------------------------------------------------
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
  v_event_open_refunds BIGINT := 0;
  v_event_settled_payouts BIGINT := 0;
  v_event_locked_payouts BIGINT := 0;
  v_event_available_payable BIGINT := 0;
  v_community_open_refunds BIGINT := 0;
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

  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = v_payout_community_id
  FOR UPDATE;

  SELECT pi.* INTO v_payout
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Community not found.');
  END IF;

  SELECT e.* INTO v_event
  FROM public.events e
  WHERE e.id = v_payout.event_id;

  IF v_event.community_id != v_payout_community_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Event does not belong to the selected community.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payout_items
    WHERE community_id = v_payout_community_id
      AND COALESCE(event_id, '00000000-0000-0000-0000-000000000000'::UUID) = COALESCE(v_payout.event_id, '00000000-0000-0000-0000-000000000000'::UUID)
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

  SELECT COALESCE(SUM((pal.details->>'amount')::BIGINT), 0)
  INTO v_event_gross_organizer_share
  FROM public.payment_audit_log pal
  WHERE pal.action = 'wallet_credited'
    AND pal.details->>'event_id' IS NOT NULL
    AND (pal.details->>'event_id')::uuid = v_payout.event_id;

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
    AND NOT (COALESCE(p.refund_amount_due, 0) > 0)
  )
  SELECT COALESCE(SUM(single_refund_debit), 0)::BIGINT
  INTO v_event_refund_debits
  FROM calculated_refunds;

  SELECT COALESCE(SUM(GREATEST(0, LEAST(
           GREATEST(COALESCE(p.organizer_share, 0), 0),
           GREATEST(COALESCE(p.refund_amount_due, 0), 0)
         ))), 0)::BIGINT
  INTO v_event_open_refunds
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  WHERE r.event_id = v_payout.event_id
    AND COALESCE(p.refund_amount_due, 0) > 0;

  v_event_refund_debits := v_event_refund_debits + v_event_open_refunds;

  SELECT COALESCE(SUM(amount), 0)::BIGINT
  INTO v_event_settled_payouts
  FROM public.payout_items
  WHERE event_id = v_payout.event_id
    AND status = 'success';

  SELECT COALESCE(SUM(amount), 0)::BIGINT
  INTO v_event_locked_payouts
  FROM public.payout_items
  WHERE event_id = v_payout.event_id
    AND status IN ('pending_confirmation', 'disputed')
    AND id <> p_payout_id;

  v_event_available_payable := GREATEST(0, (v_event_gross_organizer_share - v_event_refund_debits - v_event_settled_payouts - v_event_locked_payouts));

  IF v_payout.amount > v_event_available_payable THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_event_payable_balance',
      'message', format('Requested payout amount (%s paise) exceeds available uncommitted event balance (%s paise). In-flight payouts and refunds still owed to customers are reserved.', v_payout.amount, v_event_available_payable),
      'event_available_payable', v_event_available_payable,
      'event_gross_earned', (v_event_gross_organizer_share - v_event_refund_debits),
      'event_refund_debits', v_event_refund_debits,
      'event_open_refunds', v_event_open_refunds,
      'event_settled_payouts', v_event_settled_payouts,
      'event_locked_payouts', v_event_locked_payouts
    );
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_locked_payouts
  FROM public.payout_items
  WHERE community_id = v_payout_community_id
    AND status IN ('pending_confirmation', 'disputed')
    AND id <> p_payout_id;

  SELECT COALESCE(SUM(GREATEST(0, LEAST(
           GREATEST(COALESCE(p.organizer_share, 0), 0),
           GREATEST(COALESCE(p.refund_amount_due, 0), 0)
         ))), 0)::BIGINT
  INTO v_community_open_refunds
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  JOIN public.events e ON e.id = r.event_id
  WHERE e.community_id = v_payout_community_id
    AND COALESCE(p.refund_amount_due, 0) > 0;

  v_uncommitted_balance := GREATEST(0, v_community.wallet_balance - v_locked_payouts - v_community_open_refunds);

  IF v_payout.amount > v_uncommitted_balance THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_uncommitted_balance',
      'message', format('Requested payout amount (%s paise) exceeds available uncommitted wallet balance (%s paise). In-flight payouts and refunds still owed to customers are reserved.', v_payout.amount, v_uncommitted_balance),
      'uncommitted_balance', v_uncommitted_balance,
      'locked_payouts', v_locked_payouts,
      'open_refund_liability', v_community_open_refunds,
      'stored_wallet_balance', v_community.wallet_balance
    );
  END IF;

  INSERT INTO public.payout_items (
    community_id, event_id, amount, currency, status, utr,
    beneficiary_id, payment_method, admin_notes, recorded_by_admin
  )
  VALUES (
    v_payout_community_id, v_payout.event_id, v_payout.amount, v_payout.currency,
    'pending_confirmation', v_normalized_utr, v_payout.beneficiary_id,
    COALESCE(p_payment_method, v_payout.payment_method, 'IMPS'), p_admin_notes, auth.uid()
  )
  RETURNING id INTO v_new_payout_id;

  UPDATE public.payout_items
  SET status = 'cancelled',
      resolved_by_admin = auth.uid(),
      resolved_at = clock_timestamp(),
      resolution_notes = 'Reissued as payout ' || v_new_payout_id || '. ' || COALESCE(p_admin_notes, ''),
      updated_at = now()
  WHERE id = p_payout_id;

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('payout_dispute_reissued', jsonb_build_object(
    'old_payout_id', p_payout_id,
    'new_payout_id', v_new_payout_id,
    'community_id', v_payout_community_id,
    'amount', v_payout.amount,
    'old_utr', v_payout.utr,
    'new_utr', v_normalized_utr,
    'open_refund_liability', v_community_open_refunds,
    'admin_id', auth.uid()
  ));

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
    'open_refund_liability', v_community_open_refunds,
    'remaining_uncommitted', v_uncommitted_balance - v_payout.amount
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'old_payout_id', p_payout_id,
    'new_payout_id', v_new_payout_id,
    'amount', v_payout.amount,
    'old_status', 'disputed',
    'new_status', 'pending_confirmation',
    'open_refund_liability', v_community_open_refunds,
    'message', 'Old disputed payout cancelled; new pending payout created. Please confirm receipt in the organizer dashboard.'
  );
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_reissue_disputed_payout(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reissue_disputed_payout(UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;


-- ----------------------------------------------------------------------------
-- Read-only liability summary for the admin ledger / payout modal.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_refund_liability_summary(
  p_community_id UUID,
  p_event_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can view refund liabilities.';
  END IF;

  SELECT jsonb_build_object(
    'open_refunds', COALESCE(SUM(GREATEST(0, LEAST(
        GREATEST(COALESCE(p.organizer_share, 0), 0),
        GREATEST(COALESCE(p.refund_amount_due, 0), 0)
      ))), 0),
    'open_refund_count', COUNT(*) FILTER (WHERE COALESCE(p.refund_amount_due, 0) > 0),
    'clawback_pending', COALESCE(SUM(
        CASE WHEN p.refund_clawback_state = 'pending'
             THEN GREATEST(COALESCE(p.organizer_share, 0), 0) ELSE 0 END
      ), 0),
    'clawback_pending_count', COUNT(*) FILTER (WHERE p.refund_clawback_state = 'pending')
  )
  INTO v_result
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  JOIN public.events e ON e.id = r.event_id
  WHERE e.community_id = p_community_id
    AND (p_event_id IS NULL OR r.event_id = p_event_id);

  RETURN v_result;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_refund_liability_summary(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_refund_liability_summary(UUID, UUID) TO authenticated, service_role;
