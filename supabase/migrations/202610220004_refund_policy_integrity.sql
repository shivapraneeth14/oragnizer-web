-- ============================================================================
-- CLUVO - P3c/P3d: refund-amount policy integrity
--
-- Business rule (must hold everywhere):
--   organizer-cancelled (event_cancellation / organizer_issue_refund /
--   capacity_full / event_cancelled / registration_cancelled auto-refund)
--     -> refund the FULL amount, platform fee included.
--   customer-cancelled (registration_cancellation)
--     -> refund amount MINUS the persisted platform fee; the fee is kept.
--
-- Problem: the amount owed was never persisted. A failed refund
-- (refund_status='failed', claim released) left refunded_amount NULL, and the
-- reconcile retry job used `refunded_amount ?? amount` — so a failed
-- CUSTOMER-cancellation refund was retried at the FULL amount including the
-- platform fee the platform is entitled to keep. The cancellation type was
-- also not persisted, so any retry re-derived (or guessed) the policy.
--
-- Fix:
--   refund_amount_due  = the exact customer-owed amount, set once at the
--                        first refund claim; cleared only when the refund is
--                        actually issued (debt settled).
--   refund_reason      = the cancellation type that determined the policy;
--                        set once at the first claim and NEVER overwritten,
--                        so stale reclaims, on-demand retries and reconcile
--                        passes can never flip one cancellation type into
--                        the other.
--   refunded_amount    = keeps meaning "actually refunded" (set on issue).
--
-- Additive columns only; released clients ignore them.
-- ============================================================================

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refund_amount_due INTEGER,
  ADD COLUMN IF NOT EXISTS refund_reason TEXT;

COMMENT ON COLUMN public.payments.refund_amount_due IS 'Outstanding customer refund under the applicable policy (full for organizer cancels, minus platform fee for customer cancels). NULL = nothing owed.';
COMMENT ON COLUMN public.payments.refund_reason IS 'Cancellation type that determined the refund policy. Set once at first claim; never overwritten.';

-- ----------------------------------------------------------------------------
-- Customer-visible refund history. The payments row is REUSED across
-- cancel -> rebook cycles (the unique (event_id,user_id) registration and
-- per-registration payment row are re-quoted for the new sale), so the
-- previous refund would vanish from the customer's payment tab after
-- rebooking. Every issued refund is archived here (written inside
-- complete_payment_refund, same transaction) so the history survives any
-- number of re-quotes. Readable by the owner (via their registration) and
-- by the community team; writable only by the service role.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_refund_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  registration_id UUID NOT NULL REFERENCES public.registrations(id) ON DELETE CASCADE,
  event_id UUID REFERENCES public.events(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  payment_amount INTEGER,
  platform_fee INTEGER,
  refund_status TEXT,
  razorpay_refund_id TEXT,
  refund_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.payment_refund_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payment_refund_history_own_registration" ON public.payment_refund_history
  FOR SELECT USING (
    registration_id in (select id from public.registrations where user_id = auth.uid())
  );

CREATE POLICY "payment_refund_history_team_read" ON public.payment_refund_history
  FOR SELECT USING (
    registration_id in (
      select r.id from public.registrations r
      join public.events e on e.id = r.event_id
      where e.community_id in (
        select id from public.communities where owner_id = auth.uid()
      ) or e.community_id in (
        select cm.community_id from public.community_members cm
        where cm.user_id = auth.uid() and cm.role in ('OWNER','ORGANIZER','MODERATOR')
      )
    )
  );

-- One history row per provider refund id (a re-quoted payment can legitimately
-- hold MULTIPLE refunds across cancel/rebook cycles — never unique on
-- payment_id alone).
CREATE UNIQUE INDEX IF NOT EXISTS payment_refund_history_refund_uniq
  ON public.payment_refund_history (payment_id, razorpay_refund_id)
  WHERE razorpay_refund_id IS NOT NULL;

-- Backfill: refunds already settled before this migration (live rows still
-- carry them; after the first re-quote they would disappear without this).
INSERT INTO public.payment_refund_history
  (payment_id, registration_id, event_id, amount, payment_amount, platform_fee,
   refund_status, razorpay_refund_id, refund_reason, created_at)
SELECT p.id, p.registration_id, r.event_id,
       COALESCE(p.refunded_amount, p.amount), p.amount, p.platform_fee,
       p.refund_status, p.razorpay_refund_id, p.refund_reason, p.updated_at
FROM public.payments p
JOIN public.registrations r ON r.id = p.registration_id
WHERE (p.status = 'refunded' OR p.refund_status = 'processed')
  AND NOT EXISTS (
    SELECT 1 FROM public.payment_refund_history h
    WHERE h.payment_id = p.id
      AND h.razorpay_refund_id IS NOT DISTINCT FROM p.razorpay_refund_id
  );

-- ----------------------------------------------------------------------------
-- claim_payment_refund(p_payment_id, p_reason, p_amount):
--   Lock the payment, validate it is refundable, and mark it 'claimed' if free.
--   On a FRESH claim persists the policy (reason) and the owed amount (due)
--   exactly once — COALESCE keeps a stale reclaim from overwriting either.
--   Returns jsonb:
--     { ok, attempt, stale_reclaimed }                 the winner
--     { conflict }                                     a fresh claim is in flight
--     { already_refunded, refund_status, razorpay_refund_id }
--     { error }
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_payment_refund(
  p_payment_id UUID,
  p_reason TEXT DEFAULT NULL,
  p_amount INTEGER DEFAULT NULL
)
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

  -- Fresh claim (or stale reclaim): persist the policy ONCE. COALESCE never
  -- overwrites a previously persisted reason/amount — a retry can only
  -- continue the original cancellation type at the original owed amount.
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

-- ----------------------------------------------------------------------------
-- complete_payment_refund(p_payment_id, p_success, p_refund_id, p_status,
--                         p_amount, p_wallet_reason):
--   Settle a claim held by the caller.
--     p_success = true  -> mark 'issued', persist the provider refund, clear
--                         refund_amount_due (debt settled), and claw back the
--                         organizer share exactly once (same lock). A clawback
--                         failure is recorded, never swallowed, never
--                         auto-retried (exactly-once); it surfaces as a
--                         refund_wallet_debit_failed audit row + alert.
--     p_success = false -> mark 'failed' so a later retry may claim again.
--                         refund_amount_due stays (set by the claim) — it is
--                         exactly what the retry must issue.
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
REVOKE ALL PRIVILEGES ON FUNCTION public.claim_payment_refund(UUID, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.complete_payment_refund(UUID, BOOLEAN, TEXT, TEXT, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_refund(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_payment_refund(UUID, BOOLEAN, TEXT, TEXT, INTEGER, TEXT) TO service_role;

-- The old single-argument signature (pre-policy claim) is superseded.
DROP FUNCTION IF EXISTS public.claim_payment_refund(UUID);
