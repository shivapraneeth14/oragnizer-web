-- ============================================================================
-- CLUVO - A3: payment-state backstop + reconcile cron restoration
--
-- Problem 1 (backstop): a cancelled registration holding a paid (or refunding)
-- payment can be raced back to `pending` by create-payment / create-booking,
-- leaving money captured with the seat lost (the Oct 12 `payyyyy` bug class).
-- create-payment is now guarded, but the database must enforce the invariant
-- no matter which code path tries it: a registration whose payment is `success`
-- (money moved) or has a live/refunding refund may never be demoted to
-- `pending`.
--
-- Problem 2 (cron): 202607300005 removed the reconcile-payments cron and left
-- the replacement commented out, so no job ever re-checks stale orders or
-- retries failed refunds. This restores it via pg_net, reading the function
-- URL and its auth secret from Vault.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Backstop trigger
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_paid_registration_demote()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'pending'
     AND OLD.status IS DISTINCT FROM 'pending'
     AND EXISTS (
       SELECT 1 FROM public.payments p
       WHERE p.registration_id = NEW.id
         AND p.deleted_at IS NULL
         AND (
           p.status = 'success'
           OR p.refund_claim_state = 'claimed'
           OR p.refund_status IN ('requested', 'pending', 'queued')
         )
     )
  THEN
    RAISE EXCEPTION 'Cannot demote registration (id %) to pending: a paid or refunding payment exists for it', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reg_block_demote_to_pending ON public.registrations;
CREATE TRIGGER reg_block_demote_to_pending
BEFORE UPDATE ON public.registrations
FOR EACH ROW EXECUTE FUNCTION public.block_paid_registration_demote();

-- ----------------------------------------------------------------------------
-- 2. Restore the reconcile-payments cron
--
-- Every 5 minutes the job asks the Edge Function to resolve anything that
-- still looks stale: confirm payments captured at Razorpay whose webhook never
-- arrived, cancel dead orders, and retry failed refunds.
--
-- The function URL + auth secret are read from Vault so nothing secret is
-- hardcoded here. An operator must seed two rows per environment (see comment
-- at the end):
--   vault.secrets 'project_url'          = https://<ref>.supabase.co
--   vault.secrets 'reconcile_service_key' = the RECONCILE_SECRET value set for
--                                            the reconcile-payments function
-- (Both are seeded for TEST by the repair run; PROD seeds them at deploy.)
-- ----------------------------------------------------------------------------
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
    '*/5 * * * *',
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

-- ----------------------------------------------------------------------------
-- Operator seed (non-secret half only; the secret is set at deploy time):
--
--   INSERT INTO vault.secrets (name, secret)
--   SELECT 'project_url', 'https://<project-ref>.supabase.co'
--   WHERE NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url');
--
--   INSERT INTO vault.secrets (name, secret)
--   SELECT 'reconcile_service_key', '<RECONCILE_SECRET>'
--   WHERE NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'reconcile_service_key');
-- ----------------------------------------------------------------------------