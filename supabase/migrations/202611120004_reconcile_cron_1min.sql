-- ============================================================================
-- CLUVO — Speed up abandoned-checkout cleanup
--
-- The reconcile worker already resolves stale `pending` payments safely (it
-- asks Razorpay before ever marking one failed). This only makes it faster:
--   * the give-up grace drops from 2 hours to 10 minutes (reconcile-pending.ts)
--   * this migration runs the worker every minute instead of every 2 minutes
--
-- Result: an abandoned checkout is cleaned up in ~10-11 minutes instead of up
-- to ~2 hours. A genuinely slow payment is still confirmed (never cancelled)
-- because the Razorpay check remains in front of every decision.
--
-- Idempotent: unschedules any prior reconcile job first.
-- ============================================================================

DO $$
DECLARE
  v_job_id BIGINT;
BEGIN
  FOR v_job_id IN
    SELECT jobid FROM cron.job WHERE jobname IN ('reconcile-payments', 'invoke-reconcile-payments')
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;

  PERFORM cron.schedule(
    'invoke-reconcile-payments',
    '* * * * *',
    'select net.http_post(
      url := (select decrypted_secret::text from vault.decrypted_secrets where name = ''project_url'' limit 1) || ''/functions/v1/reconcile-payments'',
      headers := jsonb_build_object(
        ''Content-Type'', ''application/json'',
        ''x-reconcile-secret'', (select decrypted_secret::text from vault.decrypted_secrets where name = ''reconcile_service_key'' limit 1)
      ),
      body := ''{}''::jsonb,
      timeout_milliseconds := 60000
    )'
  );
END $$;
