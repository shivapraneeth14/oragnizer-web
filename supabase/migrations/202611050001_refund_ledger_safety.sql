-- 1. Allow retry for failed refunds
CREATE OR REPLACE FUNCTION public.claim_payment_refund(p_payment_id UUID, p_reason TEXT DEFAULT NULL, p_amount INTEGER DEFAULT NULL)
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

  SELECT r.status INTO v_reg_status
  FROM public.registrations r
  WHERE r.id = v_payment.registration_id;

  IF v_reg_status = 'attended' THEN
    RETURN jsonb_build_object(
      'error', 'not_refundable_attended',
      'message', 'Attendee already attended the event - no refund'
    );
  END IF;

  -- Allow retry if refund failed previously
  IF v_payment.refund_claim_state = 'issued'
     AND v_payment.refund_status NOT IN ('failed')
     AND v_payment.refund_status IN ('processed', 'approved', 'requested', 'pending', 'queued') THEN
    RETURN jsonb_build_object(
      'already_refunded', true,
      'refund_status', v_payment.refund_status,
      'razorpay_refund_id', v_payment.razorpay_refund_id
    );
  END IF;

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
      refund_reason = COALESCE(refund_reason, p_reason),
      refund_amount_due = COALESCE(refund_amount_due, p_amount),
      updated_at = now()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'ok', true,
    'attempt', v_new_attempt,
    'stale_reclaimed', (v_payment.refund_claim_state = 'claimed')
  );
END;
$$;

-- 2. Add p_debit_wallet parameter to complete_payment_refund
CREATE OR REPLACE FUNCTION public.complete_payment_refund(
    p_payment_id uuid, 
    p_success boolean, 
    p_refund_id text DEFAULT NULL::text, 
    p_status text DEFAULT NULL::text, 
    p_amount integer DEFAULT NULL::integer, 
    p_wallet_reason text DEFAULT 'payment_refund'::text,
    p_debit_wallet boolean DEFAULT TRUE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
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

  IF v_payment.refund_claim_state <> 'claimed' AND v_payment.refund_status <> 'failed' THEN
    RETURN jsonb_build_object('error', 'No live refund claim for this payment');
  END IF;

  IF NOT p_success THEN
    UPDATE public.payments
    SET refund_claim_state = 'failed',
        refund_status = 'failed',
        updated_at = now()
    WHERE id = p_payment_id;
    RETURN jsonb_build_object('ok', true, 'issued', false);
  END IF;

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
      'refund_status', COALESCE(p_status, 'pending')
    ));

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
    DO UPDATE SET refund_status = EXCLUDED.refund_status, updated_at = now();
  END IF;

  -- Only debit if p_debit_wallet is true
  IF p_debit_wallet THEN
      SELECT r.id, r.event_id INTO v_registration
      FROM public.registrations r
      WHERE r.id = v_payment.registration_id;

      IF FOUND AND v_registration.event_id IS NOT NULL THEN
        SELECT e.community_id INTO v_community_id
        FROM public.events e
        WHERE e.id = v_registration.event_id;

        IF v_community_id IS NOT NULL THEN
          v_organizer_share := GREATEST(COALESCE(v_payment.organizer_share, 0), 0);

          IF v_organizer_share > 0 THEN
            SELECT * INTO v_debit
            FROM public.debit_wallet(v_community_id, v_organizer_share, p_wallet_reason, v_registration.event_id, p_payment_id);

            IF COALESCE(v_debit->>'error', '') <> '' THEN
              INSERT INTO public.payment_audit_log (action, payment_id, details)
              VALUES ('refund_wallet_debit_failed', p_payment_id,
                jsonb_build_object(
                  'refund_id', p_refund_id,
                  'amount', COALESCE(p_amount, v_payment.amount),
                  'error', COALESCE(v_debit->>'error', 'Wallet debit failed')
                ));
            END IF;
          END IF;
        END IF;
      END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'issued', true, 'payment_id', p_payment_id);
END;
$$;
