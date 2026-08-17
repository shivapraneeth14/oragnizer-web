-- ============================================================================
-- CLUVO - PASS 3: robust payout status tracking
-- 1. sync_payout_status_update: guarded, transactional apply of a Cashfree
--    status (idempotent even when the webhook AND the poller race).
-- 2. pg_cron job every 3 minutes polls Cashfree for stuck payouts via
--    sync-payout-status (internal secret header).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_payout_status_update(
  p_payout_id UUID,
  p_cashfree_status TEXT,
  p_utr TEXT,
  p_status_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item public.payout_items%ROWTYPE;
BEGIN
  SELECT * INTO v_item
  FROM public.payout_items
  WHERE id = p_payout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'not_found');
  END IF;

  -- Guard: only an in-flight payout may transition. If the webhook already
  -- applied the status (or a refund already ran), this is a no-op — this is
  -- what makes webhook + poller races refund-exactly-once.
  IF v_item.status NOT IN ('processing', 'in_progress') THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'already_terminal', 'status', v_item.status);
  END IF;

  IF p_cashfree_status = 'SUCCESS' THEN
    UPDATE public.payout_items
    SET status = 'success',
        utr = p_utr,
        cashfree_status = p_cashfree_status,
        status_reason = p_status_reason,
        updated_at = now()
    WHERE id = p_payout_id;

    INSERT INTO public.payment_audit_log (action, details)
    VALUES ('payout_success',
      jsonb_build_object('payout_id', p_payout_id, 'community_id', v_item.community_id,
        'amount', v_item.amount, 'utr', p_utr, 'status', p_cashfree_status, 'source', 'sync'));

    RETURN jsonb_build_object('applied', true, 'status', 'success');
  ELSIF p_cashfree_status IN ('FAILED', 'REJECTED', 'REVERSED', 'CANCELLED') THEN
    -- Mirror Cashfree's verbatim status + reason first (proof for the details
    -- dialog), then let refund_wallet restore the wallet + set status=failed
    -- — both inside this single transaction.
    UPDATE public.payout_items
    SET cashfree_status = p_cashfree_status,
        status_reason = p_status_reason,
        updated_at = now()
    WHERE id = p_payout_id
      AND status IN ('processing', 'in_progress');

    PERFORM public.refund_wallet(p_payout_id);

    INSERT INTO public.payment_audit_log (action, details)
    VALUES ('payout_failed',
      jsonb_build_object('payout_id', p_payout_id, 'community_id', v_item.community_id,
        'amount', v_item.amount, 'status', p_cashfree_status, 'reason', p_status_reason, 'source', 'sync'));

    RETURN jsonb_build_object('applied', true, 'status', 'failed');
  ELSE
    -- In-flight states (TO_PROCESS, DISPATCHED, INITIATED, PROCESSING, …):
    -- mirror Cashfree's word verbatim; row stays `processing` locally.
    UPDATE public.payout_items
    SET cashfree_status = p_cashfree_status,
        status_reason = p_status_reason,
        updated_at = now()
    WHERE id = p_payout_id;

    RETURN jsonb_build_object('applied', true, 'status', 'in_flight', 'cashfree_status', p_cashfree_status);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_payout_status_update(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_payout_status_update(UUID, TEXT, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- pg_cron: every 3 minutes, ask Cashfree about stuck payouts.
-- Runs with the internal secret; the function rejects calls without it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_job_id BIGINT;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'payout-status-sync';
  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;

  PERFORM cron.schedule(
    'payout-status-sync',
    '*/3 * * * *',
    'select net.http_post(
      url := ''https://ofvfasdgdwkehdcjugnf.supabase.co/functions/v1/sync-payout-status'',
      headers := jsonb_build_object(''Content-Type'', ''application/json'', ''x-sync-secret'', ''95d54e66c1e14dbb6fd7a8015f49b77d8b4edf408ac4fb9c''),
      body := ''{}'',
      timeout_milliseconds := 60000
    )'
  );
END $$;