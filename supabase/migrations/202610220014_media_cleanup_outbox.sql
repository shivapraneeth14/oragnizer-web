-- ============================================================================
-- CLUVO — Media cleanup outbox (defect D6)
--
-- Problem: profiles.avatar_url points to a Cloudinary-hosted image. When
-- an account is hard-deleted, the DB row cascades away but the Cloudinary
-- file persists forever. No destroy API call exists anywhere.
--
-- Fix: a durable outbox table. At purge time, the deletion job extracts
-- the Cloudinary public_id from avatar_url and inserts a row here. The
-- same daily job retries pending rows with exponential backoff. A row is
-- deleted only after Cloudinary confirms the destroy — so "pending
-- cleanup" and "completed deletion" are distinct, queryable states.
--
-- The table stores ONLY the Cloudinary public_id (a non-identifying
-- opaque token). No user id, no email, no URL — the public_id alone is
-- enough for the destroy API call and cannot re-identify anyone.
--
-- RLS: deny-all for anon/authenticated. Only service_role (edge functions)
-- reads/writes this table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.media_cleanup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL,
  provider text NOT NULL DEFAULT 'cloudinary',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_class text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index for the daily purge job: find pending rows ready for retry.
CREATE INDEX IF NOT EXISTS idx_media_cleanup_pending
  ON public.media_cleanup_jobs (next_attempt_at)
  WHERE status = 'pending';

-- Trigger: keep updated_at fresh.
CREATE OR REPLACE FUNCTION public.set_media_cleanup_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_media_cleanup_updated ON public.media_cleanup_jobs;
CREATE TRIGGER trg_media_cleanup_updated
  BEFORE UPDATE ON public.media_cleanup_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_media_cleanup_updated_at();

-- RLS: deny-all for clients. Only service_role accesses this table.
ALTER TABLE public.media_cleanup_jobs ENABLE ROW LEVEL SECURITY;
-- No policies for anon/authenticated — deny by default.
REVOKE ALL ON public.media_cleanup_jobs FROM anon, authenticated;
GRANT ALL ON public.media_cleanup_jobs TO service_role;
