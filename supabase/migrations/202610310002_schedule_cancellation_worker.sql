-- ============================================================================
-- CLUVO — STAGE 5 MILESTONE B: SCHEDULE CANCELLATION QUEUE WORKER CRON
--
-- Configures pg_cron to invoke the cancellation queue worker every 1 minute
-- (* * * * *) via pg_net using secrets retrieved securely from Vault.
-- ============================================================================

DO $$
DECLARE
  v_job_id BIGINT;
BEGIN
  -- Idempotently unschedule any prior job with these names
  FOR v_job_id IN
    SELECT jobid FROM cron.job WHERE jobname IN ('cancellation-queue-worker', 'invoke-cancellation-worker')
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;

  PERFORM cron.schedule(
    'invoke-cancellation-worker',
    '* * * * *',
    'select net.http_post(
      url := (select decrypted_secret::text from vault.decrypted_secrets where name = ''project_url'' limit 1) || ''/functions/v1/process-cancellation-queue'',
      headers := jsonb_build_object(
        ''Content-Type'', ''application/json'',
        ''x-worker-secret'', (select decrypted_secret::text from vault.decrypted_secrets where name = ''reconcile_service_key'' limit 1)
      ),
      body := ''{"source": "pg_cron"}''::jsonb,
      timeout_milliseconds := 60000
    )'
  );
END $$;

