-- ============================================================================
-- CLUVO — Update reconcile-payments cron to run every 2 minutes
--
-- Decreases reconciliation interval from 5 minutes to 2 minutes (*/2 * * * *)
-- to speed up detection of dropped webhooks and sync pending refund states.
-- ============================================================================

DO $$
DECLARE
  v_job_id BIGINT;
BEGIN
  -- Idempotent: replace any prior reconcile job.
  FOR v_job_id IN
    SELECT jobid FROM cron.job WHERE jobname IN ('reconcile-payments', 'invoke-reconcile-payments')
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;

  PERFORM cron.schedule(
    'invoke-reconcile-payments',
    '*/2 * * * *',
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
