-- ============================================================================
-- CLUVO — Payout balance fix + account-deletion privilege revoke
--
-- Bug 1: admin_record_manual_payout under-counted the event's gross earnings
--        when a payment row was reused across cancel->rebook (the original sale
--        was invisible to payments.organizer_share while the refund history
--        still subtracted it). Now sum wallet_credited audit entries, which
--        accumulate correctly across rebooks.
-- Bug 6: delete_user_auth_cascade was exposed to anon/authenticated. Revoke.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_record_manual_payout(p_community_id uuid, p_amount integer, p_utr text, p_payment_method text DEFAULT 'IMPS'::text, p_event_id uuid DEFAULT NULL::uuid, p_admin_notes text DEFAULT NULL::text)
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

    -- Compute Event Gross Organizer Sales Earned.
    -- Sum wallet_credited audit entries rather than payments.organizer_share:
    -- a payment row is REUSED across cancel->rebook, so payments.organizer_share
    -- only holds the latest sale and under-counts the historical sale, while
    -- payment_refund_history still subtracts the earlier refund (netting to 0).
    SELECT COALESCE(SUM((pal.details->>'amount')::BIGINT), 0)
    INTO v_event_gross_organizer_share
    FROM public.payment_audit_log pal
    WHERE pal.action = 'wallet_credited'
      AND pal.details->>'event_id' IS NOT NULL
      AND (pal.details->>'event_id')::uuid = p_event_id;

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
$function$;


-- ---------------------------------------------------------------------------
-- Bug 6: lock account-deletion helper to service_role only.
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON FUNCTION public.delete_user_auth_cascade(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_user_auth_cascade(uuid) TO service_role;
