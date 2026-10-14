-- ============================================================================
-- CLUVO - No refunds for attendees who already attended
--
-- Policy: an organizer-led cancellation refunds EVERYONE who has not
-- attended, at any time. Someone who already attended consumed the ticket —
-- they are NEVER refunded, regardless of when the event is cancelled.
--
-- claim_payment_refund is the single DB entry point every refund path flows
-- through (event cancellation, organizer manual refund, customer self-cancel,
-- reconcile retries). Guarding it here makes "attended => no refund" hold
-- regardless of caller. Callers that hit this get a clean
-- { error: 'not_refundable_attended' } and nothing is mutated, so no wallet
-- clawback and no Razorpay refund is ever issued.
--
-- This is a redefinition of the function created in 202610120001; identical
-- behaviour otherwise.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claim_payment_refund(p_payment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment RECORD;
  v_reg_status TEXT;
  v_new_attempt INTEGER;
BEGIN
  SELECT p.* INTO v_payment
  FROM public.payments p
  WHERE p.id = p_payment_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  IF v_payment.status NOT IN ('success', 'failed', 'refunded')
     OR v_payment.razorpay_payment_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Payment is not refundable in its current state');
  END IF;

  -- An attendee who already attended is never refundable.
  SELECT r.status INTO v_reg_status
  FROM public.registrations r
  WHERE r.id = v_payment.registration_id;

  IF v_reg_status = 'attended' THEN
    RETURN jsonb_build_object(
      'error', 'not_refundable_attended',
      'message', 'Attendee already attended the event - no refund'
    );
  END IF;

  -- Terminal states and accepted/queued provider refunds: nothing to do.
  IF v_payment.refund_claim_state = 'issued'
     OR v_payment.refund_status IN ('processed', 'approved', 'requested', 'pending', 'queued') THEN
    RETURN jsonb_build_object(
      'already_refunded', true,
      'refund_status', v_payment.refund_status,
      'razorpay_refund_id', v_payment.razorpay_refund_id
    );
  END IF;

  -- A live claim is only re-openable when it is stale (crash between the claim
  -- and the provider call). The re-claiming caller must re-check the provider
  -- for an already-issued refund before issuing a new one.
  IF v_payment.refund_claim_state = 'claimed' THEN
    IF v_payment.refund_claim_at IS NOT NULL
       AND v_payment.refund_claim_at > now() - interval '15 minutes' THEN
      RETURN jsonb_build_object('conflict', true, 'refund_claim_at', v_payment.refund_claim_at);
    END IF;
  END IF;

  v_new_attempt := COALESCE(v_payment.refund_attempt_count, 0) + 1;

  UPDATE public.payments
  SET refund_claim_state = 'claimed',
      refund_claim_at = now(),
      refund_attempt_count = v_new_attempt,
      updated_at = now()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'ok', true,
    'attempt', v_new_attempt,
    'stale_reclaimed', (v_payment.refund_claim_state = 'claimed')
  );
END;
$$;

-- Re-assert service-role-only access (same grants as 202610120001).
REVOKE ALL PRIVILEGES ON FUNCTION public.claim_payment_refund(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_refund(UUID) TO service_role;