-- ============================================================================
-- CLUVO — Community deletion grace period (30-day)
--
-- Mirrors profiles.deletion_grace_started_at / deletion_purging_at so admins
-- can schedule community deletion with a 30-day grace window, cancel before
-- purge claims it, and have the purge job remove communities after expiry.
-- ============================================================================

-- 1) Grace timestamp — set on schedule, cleared on cancel.
ALTER TABLE public.communities
  ADD COLUMN IF NOT EXISTS deletion_grace_started_at timestamptz;

-- 2) Purge claim marker — set by the purge job, cleared on failure.
ALTER TABLE public.communities
  ADD COLUMN IF NOT EXISTS deletion_purging_at timestamptz;

-- 3) Partial index for due-community lookup.
CREATE INDEX IF NOT EXISTS idx_communities_deletion_grace
  ON public.communities (deletion_grace_started_at)
  WHERE deletion_grace_started_at IS NOT NULL;

-- 4) Column grant: authenticated can read grace status
GRANT SELECT (deletion_grace_started_at) ON public.communities TO authenticated;

-- 5) Atomic claim RPC — SECURITY DEFINER, service_role only.
CREATE OR REPLACE FUNCTION public.claim_due_community_deletions(p_limit int DEFAULT 10)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id
    FROM public.communities
    WHERE deletion_grace_started_at IS NOT NULL
      AND deletion_grace_started_at <= now() - interval '30 days'
      AND deletion_purging_at IS NULL
    ORDER BY deletion_grace_started_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.communities c
  SET deletion_purging_at = now()
  FROM due
  WHERE c.id = due.id
  RETURNING c.id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_due_community_deletions(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_community_deletions(int) TO service_role;

COMMENT ON FUNCTION public.claim_due_community_deletions(int) IS
  'Atomically claims communities whose 30-day deletion grace has expired. '
  'Sets deletion_purging_at as a claim marker. FOR UPDATE SKIP LOCKED prevents '
  'concurrent purge runs from claiming the same community.';
