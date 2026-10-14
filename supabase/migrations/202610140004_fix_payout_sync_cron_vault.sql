-- ============================================================================
-- CLUVO — Fix payout-status-sync cron: stop hardcoding the TEST project
--
-- Problem
--   202608170003_payout_status_sync.sql:103-112 scheduled pg_cron job
--   'payout-status-sync' with a HARDCODED URL
--   (https://ofvfasdgdwkehdcjugnf.supabase.co/functions/v1/sync-payout-status)
--   and a HARDCODED x-sync-secret. That migration is applied to BOTH projects
--   (deploy-test.yml and deploy-prod.yml both run `supabase db push`), so on
--   PRODUCTION the cron called the TEST edge function — production payouts
--   were reconciled against the TEST environment (wrong Cashfree environment,
--   cross-environment payout-id leakage). The committed secret is also leaked
--   in git history and must be rotated.
--
-- Fix
--   Mirror the reconcile-payments cron (202610130001:79-91): read the project
--   URL and the sync secret from Vault so nothing is hardcoded and each
--   environment calls itself. The job is only (re)scheduled when both Vault
--   secrets exist, so a missed operator seed cannot install a broken job.
--
-- OPERATOR STEPS (BLOCKED-EXTERNAL — required before the job resumes):
--   Per project (TEST and PROD), set the edge secret and the Vault row to the
--   SAME freshly-rotated value (do NOT reuse the leaked value):
--
--     supabase secrets set PAYOUT_SYNC_SECRET='<new-random>' --project-ref <ref>
--
--   Then seed the Vault row. A direct INSERT into vault.secrets no longer works
--   on hosted Supabase (ERROR 42501 permission denied for function
--   _crypto_aead_det_noncegen) — use the vault helper, which creates on first
--   run and updates thereafter:
--
--     DO $$
--     DECLARE v_id uuid;
--     BEGIN
--       SELECT id INTO v_id FROM vault.secrets WHERE name = 'payout_sync_secret';
--       IF v_id IS NULL THEN
--         PERFORM vault.create_secret('<new-random>', 'payout_sync_secret');
--       ELSE
--         PERFORM vault.update_secret(v_id, '<new-random>');
--       END IF;
--     END $$;
--
--   `project_url` is already seeded by the reconcile-payments setup; if not:
--     SELECT vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
-- ============================================================================

DO $$
DECLARE
  v_job_id BIGINT;
  v_has_url   BOOLEAN;
  v_has_secret BOOLEAN;
BEGIN
  -- Remove the old, hardcoded-URL job (idempotent).
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'payout-status-sync';
  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;

  SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')        INTO v_has_url;
  SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'payout_sync_secret') INTO v_has_secret;

  IF v_has_url AND v_has_secret THEN
    PERFORM cron.schedule(
      'payout-status-sync',
      '*/3 * * * *',
      'select net.http_post(
        url := (select decrypted_secret::text from vault.decrypted_secrets where name = ''project_url'' limit 1) || ''/functions/v1/sync-payout-status'',
        headers := jsonb_build_object(
          ''Content-Type'', ''application/json'',
          ''x-sync-secret'', (select decrypted_secret::text from vault.decrypted_secrets where name = ''payout_sync_secret'' limit 1)
        ),
        body := ''{}''::jsonb,
        timeout_milliseconds := 60000
      )'
    );
    RAISE NOTICE 'payout-status-sync cron scheduled against the Vault project_url';
  ELSE
    RAISE NOTICE 'payout-status-sync NOT scheduled: seed Vault secrets project_url and payout_sync_secret, then re-run this migration (or schedule manually).';
  END IF;
END $$;
