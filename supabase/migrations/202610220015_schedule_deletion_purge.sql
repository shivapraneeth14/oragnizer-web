-- ============================================================================
-- CLUVO — Schedule the daily account-deletion purge
--
-- Problem
--   purge-deleted-accounts exists but nothing invokes it. Users whose 30-day
--   grace has expired stay in limbo forever.
--
-- Fix
--   Schedule a daily pg_cron job that calls the edge function via pg_net.
--   Nothing is hardcoded: the project URL and the shared secret are read from
--   Vault, so TEST and PROD each call themselves. The job is only scheduled
--   when both Vault secrets exist, so a missed operator seed cannot install a
--   permanently-401 job.
--
-- OPERATOR STEPS (per project: TEST and PROD)
--   1. Set the edge secret:
--        supabase secrets set PURGE_SECRET='<random>' --project-ref <ref>
--   2. Seed/update the Vault row to the SAME value:
--        DO $$
--        DECLARE v_id uuid;
--        BEGIN
--          SELECT id INTO v_id FROM vault.secrets WHERE name = 'purge_secret';
--          IF v_id IS NULL THEN
--            PERFORM vault.create_secret('<random>', 'purge_secret');
--          ELSE
--            PERFORM vault.update_secret(v_id, '<random>');
--          END IF;
--        END $$;
--   3. `project_url` is already seeded for the other cron jobs. If missing:
--        SELECT vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   4. Re-run this migration (or execute the DO block) after seeding.
-- ============================================================================

DO $$
DECLARE
  v_job_id BIGINT;
  v_has_url BOOLEAN;
  v_has_secret BOOLEAN;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'purge-deleted-accounts';
  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;

  SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url') INTO v_has_url;
  SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'purge_secret') INTO v_has_secret;

  IF v_has_url AND v_has_secret THEN
    PERFORM cron.schedule(
      'purge-deleted-accounts',
      '17 3 * * *',
      'select net.http_post(
        url := (select decrypted_secret::text from vault.decrypted_secrets where name = ''project_url'' limit 1) || ''/functions/v1/purge-deleted-accounts'',
        headers := jsonb_build_object(
          ''Content-Type'', ''application/json'',
          ''x-purge-secret'', (select decrypted_secret::text from vault.decrypted_secrets where name = ''purge_secret'' limit 1)
        ),
        body := ''{}''::jsonb,
        timeout_milliseconds := 120000
      )'
    );
    RAISE NOTICE 'purge-deleted-accounts cron scheduled daily at 03:17 UTC';
  ELSE
    RAISE NOTICE 'purge-deleted-accounts NOT scheduled: seed Vault secrets project_url and purge_secret, then re-run this migration (or schedule manually).';
  END IF;
END $$;
