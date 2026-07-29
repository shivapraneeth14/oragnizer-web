ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS wallet_balance INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cashfree_beneficiary_id TEXT;

CREATE TABLE IF NOT EXISTS payout_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id),
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'success', 'failed')),
  cashfree_payout_id TEXT UNIQUE,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payout_items_community ON payout_items(community_id);
CREATE INDEX IF NOT EXISTS idx_payout_items_cashfree ON payout_items(cashfree_payout_id) WHERE cashfree_payout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payout_items_pending ON payout_items(status) WHERE status = 'pending';

ALTER TABLE payout_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payout_team_read" ON payout_items FOR SELECT
  USING (public.is_community_owner(community_id) OR public.is_community_member(community_id));

CREATE POLICY "admin_read_all_payouts" ON payout_items FOR SELECT
  USING (public.is_admin_user());

CREATE TRIGGER trg_payout_items_updated
  BEFORE UPDATE ON payout_items
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION initiate_wallet_withdrawal(
  p_community_id UUID,
  p_amount INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_community RECORD;
  v_payout_id UUID;
BEGIN
  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = p_community_id
  FOR UPDATE OF c;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Community not found');
  END IF;

  IF v_community.wallet_balance < p_amount THEN
    RETURN jsonb_build_object('error', 'Insufficient wallet balance');
  END IF;

  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('error', 'Invalid amount');
  END IF;

  UPDATE public.communities
  SET wallet_balance = wallet_balance - p_amount
  WHERE id = p_community_id;

  INSERT INTO public.payout_items (community_id, amount, status)
  VALUES (p_community_id, p_amount, 'pending')
  RETURNING id INTO v_payout_id;

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('withdrawal_initiated',
    jsonb_build_object('community_id', p_community_id, 'amount', p_amount, 'payout_id', v_payout_id));

  RETURN jsonb_build_object(
    'payout_id', v_payout_id,
    'amount', p_amount,
    'wallet_balance', v_community.wallet_balance - p_amount
  );
END;
$$;

CREATE OR REPLACE FUNCTION credit_wallet(
  p_community_id UUID,
  p_amount INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.communities
  SET wallet_balance = wallet_balance + p_amount
  WHERE id = p_community_id;

  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('wallet_credited',
    jsonb_build_object('community_id', p_community_id, 'amount', p_amount));

  RETURN jsonb_build_object('credited', true, 'amount', p_amount);
END;
$$;

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

  IF v_item.status = 'success' THEN
    RETURN jsonb_build_object('error', 'Cannot refund a successful payout');
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
  UPDATE public.registrations SET status = 'confirmed' WHERE id = v_payment.registration_id;

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
  PERFORM public.cancel_stale_pending();

  FOR v_rec IN
    SELECT p.id, p.razorpay_order_id, p.registration_id
    FROM public.payments p
    WHERE p.status = 'created'
      AND p.created_at < now() - INTERVAL '10 minutes'
      AND p.deleted_at IS NULL
  LOOP
    UPDATE public.payments SET status = 'failed', updated_at = now()
    WHERE id = v_rec.id AND status = 'created';

    UPDATE public.registrations SET status = 'cancelled', updated_at = now()
    WHERE id = v_rec.registration_id AND status = 'pending';

    INSERT INTO public.payment_audit_log (action, payment_id, details)
    VALUES ('payment_expired', v_rec.id,
      jsonb_build_object('razorpay_order_id', v_rec.razorpay_order_id));

    v_count := v_count + 1;
  END LOOP;

  FOR v_rec IN
    SELECT pt.id, pt.payment_id, pt.community_id, pt.amount
    FROM public.payment_transfers pt
    JOIN public.communities c ON c.id = pt.community_id
    WHERE pt.status = 'pending'
      AND c.razorpay_account_status = 'activated'
      AND c.razorpay_account_id IS NOT NULL
      AND pt.created_at < now() - INTERVAL '5 minutes'
  LOOP
    UPDATE public.payment_transfers SET status = 'processed', updated_at = now()
    WHERE id = v_rec.id AND status = 'pending';

    INSERT INTO public.payment_audit_log (action, payment_id, transfer_id, details)
    VALUES ('transfer_retried', v_rec.payment_id, v_rec.id,
      jsonb_build_object('community_id', v_rec.community_id, 'amount', v_rec.amount));

    v_count := v_count + 1;
  END LOOP;

  FOR v_rec IN
    SELECT pi.id, pi.community_id, pi.amount
    FROM public.payout_items pi
    WHERE pi.status = 'pending'
      AND pi.created_at < now() - INTERVAL '30 minutes'
  LOOP
    UPDATE public.communities
    SET wallet_balance = wallet_balance + v_rec.amount
    WHERE id = v_rec.community_id;

    UPDATE public.payout_items
    SET status = 'failed', error_message = 'Stuck payout auto-refunded by reconciliation', updated_at = now()
    WHERE id = v_rec.id AND status = 'pending';

    INSERT INTO public.payment_audit_log (action, details)
    VALUES ('payout_stuck_refunded',
      jsonb_build_object('payout_id', v_rec.id, 'community_id', v_rec.community_id, 'amount', v_rec.amount));

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
