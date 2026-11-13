-- ============================================================================
-- F1 — Payout reserve double-count fix
--
-- An issued (pending/queued/failed) refund satisfies BOTH reserve conditions:
--   * refund_amount_due > 0            (open refund liability), and
--   * a refund_clawbacks row 'pending' (organizer share not yet clawed back).
-- The same rupees were therefore reserved twice, understating the organizer's
-- withdrawable balance (safe direction, but wrong number). Once a clawback row
-- exists it is the single authority for that debt, so exclude those payments
-- from the open-refund sum.
--
-- Only the community-level reserve changes. Nothing else in the function moves.
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
  v_community_clawback_pending BIGINT := 0;
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
    AND COALESCE(p.refund_amount_due, 0) > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.refund_clawbacks cb
      WHERE cb.payment_id = p.id
    );

  -- Settled customer refunds whose organizer clawback is still short. The
  -- customer already got the money, so this share must not be paid out.
  -- Durable debt table: immune to a requote rewriting payments.organizer_share.
  SELECT COALESCE(SUM(cb.amount), 0)::BIGINT
  INTO v_community_clawback_pending
  FROM public.refund_clawbacks cb
  WHERE cb.community_id = p_community_id
    AND cb.state = 'pending';

  v_uncommitted_balance := GREATEST(0, v_community.wallet_balance - v_locked_payouts - v_community_open_refunds - v_community_clawback_pending);

  IF p_amount > v_uncommitted_balance THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_uncommitted_balance',
      'message', format('Requested payout amount (%s paise) exceeds available uncommitted wallet balance (%s paise). In-flight payouts and refunds still owed to customers are reserved.', p_amount, v_uncommitted_balance),
      'uncommitted_balance', v_uncommitted_balance,
      'locked_payouts', v_locked_payouts,
      'open_refund_liability', v_community_open_refunds,
      'clawback_pending', v_community_clawback_pending,
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
    'clawback_pending', v_community_clawback_pending,
    'remaining_uncommitted', v_uncommitted_balance - p_amount
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'payout_id', v_payout_id,
    'amount', p_amount,
    'status', 'pending_confirmation',
    'open_refund_liability', v_community_open_refunds,
    'clawback_pending', v_community_clawback_pending,
    'uncommitted_balance', (v_uncommitted_balance - p_amount)
  );
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_record_manual_payout(UUID, INTEGER, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_record_manual_payout(UUID, INTEGER, TEXT, TEXT, UUID, TEXT) TO authenticated, service_role;
