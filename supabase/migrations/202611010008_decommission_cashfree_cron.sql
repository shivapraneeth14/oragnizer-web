-- CLUVO — Decommission obsolete Cashfree sync cron
-- Item 1 of Stage 6 Phase 1 Remediation (BUG-002)
-- Unschedules the obsolete payout-status-sync cron job from pg_cron.

DO $$
DECLARE
  v_job_id BIGINT;
BEGIN
  -- Search for payout-status-sync in cron.job
  SELECT jobid INTO v_job_id 
  FROM cron.job 
  WHERE jobname = 'payout-status-sync';

  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
    RAISE NOTICE 'payout-status-sync cron job (id: %) unscheduled successfully', v_job_id;
  ELSE
    RAISE NOTICE 'payout-status-sync cron job not found; nothing to unschedule';
  END IF;
END $$;

