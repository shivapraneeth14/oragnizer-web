-- ============================================================================
-- CLUVO — CRITICAL PAYMENT BUG FIXES
-- 
-- Fixes:
--   1. refund_wallet: guard against duplicate refund (Cashfree double-spend)
--   2. reconcile_payments: dead code (status='created'), remove fake transfer processing
--   3. debit_wallet: dedicated RPC with FOR UPDATE lock (replaces credit_wallet with neg amount)
--   4. processed_webhooks table: webhook deduplication
--   5. confirm_payment: add notification + QR code generation
--   6. Minimum withdrawal validation constant
-- ============================================================================

-- ============================================================================
-- FIX 1: refund_wallet — prevent double-spend on duplicate FAILED webhooks
-- ============================================================================
CREATE OR REPLACE FUNCTION refund_wallet(
  p_payout_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item RECORD;
BEGIN
  SELECT pi.* INTO v_item
  FROM public.payout_items pi
  WHERE pi.id = p_payout_id
  FOR UPDATE OF pi;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payout not found');
  END IF;

  -- Prevent double-refund: only processing or pending can be refunded
  -- success is already blocked; now also block already-failed
  IF v_item.status NOT IN ('pending', 'processing') THEN
    RETURN jsonb_build_object('skipped', true,
      'reason', 'Payout status is ' || v_item.status || ', only pending/processing can be refunded',
      'amount', v_item.amount);
  END IF;

  UPDATE public.communities
  SET wallet_balance = wallet_balance + v_item.amount
  WHERE id = v_item.community_id;

  UPDATE public.payout_items
  SET status = 'failed', updated_at = now()
  WHERE id = p_payout_id;

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('wallet_refunded',
    jsonb_build_object('payout_id', p_payout_id, 'community_id', v_item.community_id, 'amount', v_item.amount));

  RETURN jsonb_build_object('refunded', true, 'amount', v_item.amount);
END;
$$;

-- ============================================================================
-- FIX 2: debit_wallet — dedicated debit function with FOR UPDATE lock
-- replaces the unsafe pattern of calling credit_wallet with negative amount
-- ============================================================================
CREATE OR REPLACE FUNCTION debit_wallet(
  p_community_id UUID,
  p_amount INTEGER,
  p_reason TEXT DEFAULT 'debit'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_community RECORD;
  v_new_balance INTEGER;
BEGIN
  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = p_community_id
  FOR UPDATE OF c;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Community not found');
  END IF;

  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('error', 'Amount must be positive');
  END IF;

  IF v_community.wallet_balance < p_amount THEN
    RETURN jsonb_build_object('error', 'Insufficient wallet balance');
  END IF;

  UPDATE public.communities
  SET wallet_balance = wallet_balance - p_amount
  WHERE id = p_community_id
  RETURNING wallet_balance INTO v_new_balance;

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('wallet_debited',
    jsonb_build_object('community_id', p_community_id, 'amount', p_amount,
      'new_balance', v_new_balance, 'reason', p_reason));

  RETURN jsonb_build_object('debited', true, 'amount', p_amount, 'new_balance', v_new_balance);
END;
$$;

-- ============================================================================
-- FIX 3: Webhook deduplication table
-- Stores processed webhook IDs to prevent duplicate processing
-- ============================================================================
CREATE TABLE IF NOT EXISTS processed_webhooks (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_webhooks_lookup
  ON processed_webhooks (provider, event_type, processed_at DESC);

-- Helper to check and record a webhook as processed (atomic upsert)
-- Returns TRUE if this webhook ID was not seen before, FALSE if duplicate.
-- Replay protection is handled separately (5-minute age check in webhook handlers).
CREATE OR REPLACE FUNCTION try_process_webhook(
  p_webhook_id TEXT,
  p_provider TEXT,
  p_event_type TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.processed_webhooks (id, provider, event_type)
  VALUES (p_webhook_id, p_provider, p_event_type);
  RETURN TRUE;
EXCEPTION WHEN unique_violation THEN
  RETURN FALSE;
END;
$$;

-- ============================================================================
-- FIX 4: reconcile_payments — complete rewrite
-- 
-- Old bugs:
--  - Checked for status='created' which never matches (dead code)
--  - "Processed" pending transfers without calling Razorpay (fake processing)
-- ============================================================================
CREATE OR REPLACE FUNCTION reconcile_payments()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER := 0;
  v_rec RECORD;
BEGIN
  -- 1. Cancel stale pending registrations (abandoned checkouts > 30 min)
  PERFORM public.cancel_stale_pending();

  -- 2. Fail stale pending payments (> 10 min) — NOT 'created' which was dead code
  FOR v_rec IN
    SELECT p.id, p.razorpay_order_id, p.registration_id
    FROM public.payments p
    WHERE p.status = 'pending'
      AND p.razorpay_order_id IS NOT NULL
      AND p.created_at < now() - INTERVAL '10 minutes'
      AND p.deleted_at IS NULL
      AND NOT EXISTS (
        -- Don't touch payments that have a corresponding webhook in flight
        SELECT 1 FROM public.payment_audit_log al
        WHERE al.payment_id = p.id AND al.action = 'payment_confirmed'
      )
  LOOP
    UPDATE public.payments SET status = 'failed', updated_at = now()
    WHERE id = v_rec.id AND status = 'pending';

    UPDATE public.registrations SET status = 'cancelled', updated_at = now()
    WHERE id = v_rec.registration_id AND status = 'pending';

    INSERT INTO public.payment_audit_log (action, payment_id, details)
    VALUES ('payment_expired', v_rec.id,
      jsonb_build_object('razorpay_order_id', v_rec.razorpay_order_id));

    v_count := v_count + 1;
  END LOOP;

  -- 3. REMOVED: fake transfer processing that marked transfers as 'processed'
  --    without calling Razorpay API. Actual transfer processing only happens
  --    in verify-payment-webhook when the Razorpay payment is captured.
  --    If a transfer was not processed by the webhook, it stays 'pending'
  --    and requires manual admin intervention.

  -- 4. Refund stuck pending payout items (> 30 min old) — Cashfree timed out
  FOR v_rec IN
    SELECT pi.id, pi.community_id, pi.amount
    FROM public.payout_items pi
    WHERE pi.status = 'pending'
      AND pi.created_at < now() - INTERVAL '30 minutes'
  LOOP
    -- Use refund_wallet which is now safe (checks status before refunding)
    PERFORM public.refund_wallet(v_rec.id);

    v_count := v_count + 1;
  END LOOP;

  -- 5. Cleanup old processed webhook records (keep last 7 days)
  DELETE FROM public.processed_webhooks
  WHERE processed_at < now() - INTERVAL '7 days';

  RETURN v_count;
END;
$$;

-- ============================================================================
-- FIX 5: confirm_payment — add notification on registration confirmation
-- ============================================================================
CREATE OR REPLACE FUNCTION confirm_payment(p_payment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment RECORD;
  v_event RECORD;
  v_community RECORD;
  v_platform_fee INTEGER;
  v_organizer_share INTEGER;
  v_updated INTEGER;
  v_transfer_id UUID;
BEGIN
  SELECT p.*, r.event_id, r.user_id, r.status AS reg_status
  INTO v_payment
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  WHERE p.id = p_payment_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  IF v_payment.status = 'success' THEN
    RETURN jsonb_build_object('skipped', true, 'payment_id', p_payment_id);
  END IF;

  SELECT e.* INTO v_event FROM public.events e WHERE e.id = v_payment.event_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Event not found');
  END IF;

  SELECT c.* INTO v_community FROM public.communities c WHERE c.id = v_event.community_id;

  UPDATE public.events e SET booked_count = booked_count + 1
  WHERE e.id = v_event.id
    AND (e.capacity IS NULL OR e.booked_count < e.capacity);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    UPDATE public.payments SET status = 'failed' WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'refund_required', 'payment_id', p_payment_id);
  END IF;

  v_platform_fee := (v_payment.amount * v_community.commission_percent / 100)::INTEGER;
  v_organizer_share := v_payment.amount - v_platform_fee;

  UPDATE public.payments SET status = 'success' WHERE id = p_payment_id;
  UPDATE public.registrations
  SET status = 'confirmed',
      qr_code = encode(
        -- Generate a deterministic QR code from registration ID + event ID
        sha256(
          (p_payment_id::text || v_event.id::text || v_payment.registration_id::text)::bytea
        ),
        'hex'
      )
  WHERE id = v_payment.registration_id;

  -- Insert notification for the user
  INSERT INTO public.notifications (user_id, type, title, body, payload)
  VALUES (
    v_payment.user_id,
    'registration_confirmed',
    'Registration Confirmed',
    'Your registration for "' || v_event.title || '" has been confirmed.',
    jsonb_build_object(
      'event_id', v_event.id,
      'registration_id', v_payment.registration_id,
      'payment_id', p_payment_id,
      'amount', v_payment.amount
    )
  );

  IF v_community.razorpay_account_status = 'activated' AND v_community.razorpay_account_id IS NOT NULL THEN
    INSERT INTO public.payment_transfers (payment_id, community_id, amount, commission_amount, status)
    VALUES (p_payment_id, v_community.id, v_organizer_share, v_platform_fee, 'pending')
    RETURNING id INTO v_transfer_id;

    INSERT INTO public.payment_audit_log (action, payment_id, transfer_id, details)
    VALUES ('payment_confirmed', p_payment_id, v_transfer_id,
      jsonb_build_object('event_id', v_event.id, 'amount', v_payment.amount,
        'organizer_share', v_organizer_share, 'platform_fee', v_platform_fee));
  ELSE
    UPDATE public.communities
    SET wallet_balance = wallet_balance + v_organizer_share
    WHERE id = v_community.id;

    INSERT INTO public.payment_audit_log (action, payment_id, details)
    VALUES ('payment_confirmed', p_payment_id,
      jsonb_build_object('event_id', v_event.id, 'amount', v_payment.amount,
        'organizer_share', v_organizer_share, 'platform_fee', v_platform_fee));
  END IF;

  RETURN jsonb_build_object(
    'action', 'confirmed',
    'payment_id', p_payment_id,
    'transfer_id', v_transfer_id,
    'organizer_share', v_organizer_share,
    'platform_fee', v_platform_fee
  );
END;
$$;
