-- ============================================================================
-- CLUVO STAGE 5 REMEDIATION — FIX 1: PAY-REL-006
-- Fix column name in confirm_payment_from_webhook:
-- Use processed_webhooks.processed_at instead of non-existent created_at.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_payment_from_webhook(
  p_payment_id UUID,
  p_webhook_id TEXT,
  p_razorpay_payment_id TEXT,
  p_expected_amount INTEGER,
  p_expected_currency TEXT DEFAULT 'INR'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_confirm_res JSONB;
BEGIN
  -- 1. Check if webhook event already processed (idempotency)
  IF EXISTS (SELECT 1 FROM public.processed_webhooks WHERE id = p_webhook_id) THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'already_processed');
  END IF;

  -- 2. Execute payment confirmation with strict lock hierarchy and security validations
  v_confirm_res := public.confirm_payment(
    p_payment_id => p_payment_id,
    p_expected_amount => p_expected_amount,
    p_expected_currency => p_expected_currency,
    p_razorpay_payment_id => p_razorpay_payment_id
  );

  IF v_confirm_res->>'error' IS NOT NULL THEN
    RETURN v_confirm_res;
  END IF;

  -- 3. Atomically record webhook deduplication inside the same transaction
  -- Schema fix: processed_webhooks column is processed_at (NOT created_at)
  INSERT INTO public.processed_webhooks (id, provider, event_type, processed_at)
  VALUES (p_webhook_id, 'razorpay', 'payment.captured', clock_timestamp())
  ON CONFLICT (id) DO NOTHING;

  RETURN v_confirm_res;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment_from_webhook(UUID, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_payment_from_webhook(UUID, TEXT, TEXT, INTEGER, TEXT) TO service_role;

