-- ============================================================================
-- CLUVO STAGE 5 REMEDIATION — FIX 2: FIN-REL-008
-- Prevent duplicate active manual payout entries while preserving:
-- 1. Offline bank transfer recording (Cluvo does NOT send money).
-- 2. Multiple-event settlement attribution using a single bank UTR.
-- 3. Partial payouts.
-- 4. Re-recording after cancellation or dispute.
-- 5. Case/whitespace normalization via UPPER(TRIM(utr)).
-- 6. Zero wallet deduction until organizer confirms receipt.
-- ============================================================================

-- 1. Concurrency-safe scoped compound partial unique index on payout_items
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_items_active_transfer
  ON public.payout_items (
    community_id,
    COALESCE(event_id, '00000000-0000-0000-0000-000000000000'::UUID),
    UPPER(TRIM(utr))
  )
  WHERE status IN ('pending_confirmation', 'success');

-- 2. Update admin_record_manual_payout RPC with duplicate checking and UTR normalization
CREATE OR REPLACE FUNCTION public.admin_record_manual_payout(
  p_community_id UUID,
  p_amount INTEGER,
  p_utr TEXT,
  p_payment_method TEXT DEFAULT 'IMPS',
  p_event_id UUID DEFAULT NULL,
  p_admin_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_community RECORD;
  v_beneficiary RECORD;
  v_payout_id UUID;
  v_normalized_utr TEXT;
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

  SELECT c.* INTO v_community
  FROM public.communities c
  WHERE c.id = p_community_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Community not found.');
  END IF;

  -- Find active beneficiary
  SELECT cb.* INTO v_beneficiary
  FROM public.community_beneficiaries cb
  WHERE cb.community_id = p_community_id
    AND cb.is_active = true
  LIMIT 1;

  -- Record transfer in pending_confirmation state (wallet_balance is NOT deducted)
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

  -- Append to immutable payment audit log
  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('manual_payout_recorded', jsonb_build_object(
    'payout_id', v_payout_id,
    'community_id', p_community_id,
    'event_id', p_event_id,
    'amount', p_amount,
    'utr', v_normalized_utr,
    'admin_id', auth.uid()
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'payout_id', v_payout_id,
    'amount', p_amount,
    'status', 'pending_confirmation'
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_record_manual_payout(UUID, INTEGER, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_record_manual_payout(UUID, INTEGER, TEXT, TEXT, UUID, TEXT) TO authenticated, service_role;

