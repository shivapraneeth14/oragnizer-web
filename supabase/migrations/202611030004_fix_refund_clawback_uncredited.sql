-- ============================================================================
-- CLUVO — Fix refund clawback of never-credited organizer share (W3)
--
-- FINDING W3: complete_payment_refund clawed back `amount - fee` whenever
-- organizer_share was NULL, even for payments that were never confirmed
-- (capacity_full, or captured while the event was cancelled). That debited the
-- organizer's wallet for earnings they never received.
--
-- FIX: claw back only the persisted organizer_share, which confirm_payment sets
-- only on a successful confirm. A never-confirmed payment keeps NULL (-> 0), so
-- no clawback happens.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.complete_payment_refund(p_payment_id uuid, p_success boolean, p_refund_id text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_amount integer DEFAULT NULL::integer, p_wallet_reason text DEFAULT 'payment_refund'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_payment RECORD;
  v_registration RECORD;
  v_community_id UUID;
  v_event_id UUID;
  v_organizer_share INTEGER;
  v_debit JSONB;
BEGIN
  SELECT p.* INTO v_payment
  FROM public.payments p
  WHERE p.id = p_payment_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  IF v_payment.refund_claim_state <> 'claimed' THEN
    RETURN jsonb_build_object('error', 'No live refund claim for this payment');
  END IF;

  IF NOT p_success THEN
    -- Failed: keep refund_amount_due (persisted by the claim) — it is the
    -- outstanding customer debt the retry must settle at, never re-derived.
    UPDATE public.payments
    SET refund_claim_state = 'failed',
        refund_status = 'failed',
        updated_at = now()
    WHERE id = p_payment_id;
    RETURN jsonb_build_object('ok', true, 'issued', false);
  END IF;

  -- Issued: persist the provider truth first. refund_amount_due is cleared —
  -- the debt is settled; refunded_amount is the actual amount refunded.
  UPDATE public.payments
  SET status = 'refunded',
      refund_status = COALESCE(p_status, 'pending'),
      razorpay_refund_id = p_refund_id,
      refunded_amount = COALESCE(p_amount, v_payment.amount),
      refund_amount_due = NULL,
      refund_claim_state = 'issued',
      refund_claim_at = now(),
      updated_at = now()
  WHERE id = p_payment_id;

  INSERT INTO public.payment_audit_log (action, payment_id, details)
  VALUES ('refund_issued', p_payment_id,
    jsonb_build_object(
      'refund_id', p_refund_id,
      'amount', COALESCE(p_amount, v_payment.amount),
      'refund_status', COALESCE(p_status, 'pending'),
      'refund_reason', v_payment.refund_reason,
      'claim_attempt', v_payment.refund_attempt_count
    ));

  -- Archive into the customer-visible refund history (same transaction) so
  -- the refund survives this payment row being re-quoted for a new sale.
  IF p_refund_id IS NOT NULL THEN
    INSERT INTO public.payment_refund_history
      (payment_id, registration_id, event_id, amount, payment_amount, platform_fee,
       refund_status, razorpay_refund_id, refund_reason)
    SELECT p_payment_id, v_payment.registration_id, r.event_id,
           COALESCE(p_amount, v_payment.amount), v_payment.amount, v_payment.platform_fee,
           COALESCE(p_status, 'pending'), p_refund_id, v_payment.refund_reason
    FROM public.registrations r
    WHERE r.id = v_payment.registration_id
    ON CONFLICT (payment_id, razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL
    DO NOTHING;
  END IF;

  -- Claw back the organizer share exactly once (inside this same lock/transaction).
  SELECT r.id, r.event_id INTO v_registration
  FROM public.registrations r
  WHERE r.id = v_payment.registration_id;

  IF FOUND AND v_registration.event_id IS NOT NULL THEN
    SELECT e.community_id INTO v_community_id
    FROM public.events e
    WHERE e.id = v_registration.event_id;

    IF v_community_id IS NOT NULL THEN
      v_organizer_share := GREATEST(COALESCE(v_payment.organizer_share, 0), 0);

      v_event_id := v_registration.event_id;

      IF v_organizer_share > 0 THEN
        SELECT * INTO v_debit
        FROM public.debit_wallet(v_community_id, v_organizer_share, p_wallet_reason, v_event_id, p_payment_id);

        IF COALESCE(v_debit->>'error', '') <> '' THEN
          INSERT INTO public.payment_audit_log (action, payment_id, details)
          VALUES ('refund_wallet_debit_failed', p_payment_id,
            jsonb_build_object(
              'refund_id', p_refund_id,
              'amount', COALESCE(p_amount, v_payment.amount),
              'reason', p_wallet_reason,
              'error', COALESCE(v_debit->>'error', 'Wallet debit failed'),
              'note', 'Customer refunded but organizer wallet clawback failed - manual follow-up required'
            ));
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'issued', true, 'payment_id', p_payment_id);
END;
$function$

