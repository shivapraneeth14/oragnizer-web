-- ============================================================================
-- CLUVO - PASS 4: refund idempotency hardening
-- refund_wallet could double-credit: it only blocked 'success' payouts, so a
-- second webhook with a different status string (FAILED then REJECTED) or a
-- repeated manual call would restore the wallet again. Now a payout already
-- marked 'failed' is a no-op (already_refunded) — the wallet can never be
-- credited twice for the same payout, from any caller.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refund_wallet(
  p_payout_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item public.payout_items%ROWTYPE;
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

  IF v_item.status = 'failed' THEN
    RETURN jsonb_build_object('already_refunded', true, 'amount', v_item.amount);
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
