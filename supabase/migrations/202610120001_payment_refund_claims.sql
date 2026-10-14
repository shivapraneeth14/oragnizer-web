-- ============================================================================
-- CLUVO - A1: exactly-once refund claims
--
-- Problem: a refund is three unlocked steps (read payment -> Razorpay refund ->
-- update DB). cancel-event, cancel-registration, issue-refund and the
-- reconcile retry job all guard on a stale snapshot, so two concurrent requests
-- can both pass the guard and refund one payment twice.
--
-- Fix: any refund attempt must first claim the payment atomically
-- (SELECT ... FOR UPDATE serializes concurrent callers; the loser sees a fresh
-- 'claimed' state and backs off with a clean conflict). The winner calls the
-- provider, then settles the claim, which also claws back the organizer share
-- exactly once inside the same lock/transaction.
--
-- Claim lifecycle on payments.refund_claim_state:
--   none -> claimed -> issued | failed
--   claimed  = provider call in flight (held). A crash mid-call leaves this.
--              Stale after 15 minutes; then a later claimant may re-claim, and
--              MUST re-check the provider for an already-issued refund first.
--   issued   = provider accepted the refund; wallet clawback recorded with it.
--   failed   = provider rejected it; a later retry may claim again.
--
-- Additive columns only; released Flutter/web clients do not read them.
-- ============================================================================

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refund_claim_state TEXT NOT NULL DEFAULT 'none'
    CHECK (refund_claim_state IN ('none', 'claimed', 'issued', 'failed')),
  ADD COLUMN IF NOT EXISTS refund_claim_at TIMESTAMPTZ;

COMMENT ON COLUMN public.payments.refund_claim_state IS 'Refund claim lifecycle for exactly-once refund issuance and wallet clawback';

-- ----------------------------------------------------------------------------
-- claim_payment_refund(p_payment_id):
--   Lock the payment, validate it is refundable, and mark it 'claimed' if free.
--   Returns jsonb:
--     { ok, attempt, stale_reclaimed }                 the winner
--     { conflict }                                     a fresh claim is in flight
--     { already_refunded, refund_status, razorpay_refund_id }
--     { error }
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_payment_refund(p_payment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment RECORD;
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

-- ----------------------------------------------------------------------------
-- complete_payment_refund(p_payment_id, p_success, p_refund_id, p_status,
--                         p_amount, p_wallet_reason):
--   Settle a claim held by the caller.
--     p_success = true  -> mark 'issued', persist the provider refund, and claw
--                         back the organizer share exactly once (same lock).
--                         A clawback failure is recorded, never swallowed, and
--                         never auto-retried (exactly-once); it surfaces as a
--                         refund_wallet_debit_failed audit row + alert.
--     p_success = false -> mark 'failed' so a later retry may claim again.
--   Only the claim holder may settle; without a live 'claimed' state this is
--   a no-op error (prevents a loser from stamping the row).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_payment_refund(
  p_payment_id UUID,
  p_success BOOLEAN,
  p_refund_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_amount INTEGER DEFAULT NULL,
  p_wallet_reason TEXT DEFAULT 'payment_refund'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

  IF v_payment.refund_claim_state <> 'claimed' THEN
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

  -- Issued: persist the provider truth first.
  UPDATE public.payments
  SET status = 'refunded',
      refund_status = COALESCE(p_status, 'pending'),
      razorpay_refund_id = p_refund_id,
      refunded_amount = COALESCE(p_amount, v_payment.amount),
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
      'claim_attempt', v_payment.refund_attempt_count
    ));

  -- Claw back the organizer share exactly once (inside this same lock/transaction).
  SELECT r.id, r.event_id INTO v_registration
  FROM public.registrations r
  WHERE r.id = v_payment.registration_id;

  IF FOUND AND v_registration.event_id IS NOT NULL THEN
    SELECT e.community_id INTO v_community_id
    FROM public.events e
    WHERE e.id = v_registration.event_id;

    IF v_community_id IS NOT NULL THEN
      v_organizer_share := COALESCE(
        v_payment.organizer_share,
        GREATEST(COALESCE(v_payment.amount, 0) - COALESCE(v_payment.platform_fee, 0), 0)
      );
      v_event_id := v_registration.event_id;

      IF v_organizer_share > 0 THEN
        SELECT * INTO v_debit
        FROM public.debit_wallet(v_community_id, v_organizer_share, p_wallet_reason, v_event_id);

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
$$;

-- Service role may only ever run the claim machine; the public client never
-- touches it directly. Existing grants on other functions are untouched.
REVOKE ALL PRIVILEGES ON FUNCTION public.claim_payment_refund(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.complete_payment_refund(UUID, BOOLEAN, TEXT, TEXT, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_refund(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_payment_refund(UUID, BOOLEAN, TEXT, TEXT, INTEGER, TEXT) TO service_role;