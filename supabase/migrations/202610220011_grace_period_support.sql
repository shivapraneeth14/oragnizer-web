-- ============================================================================
-- CLUVO — Grace-period deletion support
--
-- Adds the columns and RPC needed for the 30-day grace-period deletion model:
--   1. profiles.deletion_grace_started_at — set when the user requests
--      deletion; cleared when they cancel. NULL means "not in grace".
--   2. profiles.deletion_purging_at — concurrency claim marker. Set by the
--      purge job when it picks a user up; cleared on failure so a retry can
--      pick it up again.
--   3. claim_due_deletions(p_limit) — atomic, SKIP-LOCKED claim of users
--      whose grace period has expired. Returns the claimed profile ids.
--   4. Column grants: authenticated users can read their own
--      deletion_grace_started_at (self-read RLS + column grant).
--   5. Partial index on deletion_grace_started_at for fast due-user lookup.
-- ============================================================================

-- 1. Grace timestamp — set on request, cleared on cancel.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deletion_grace_started_at timestamptz;

-- 2. Purge claim marker — set by the purge job, cleared on failure.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deletion_purging_at timestamptz;

-- 3. Partial index: only rows in grace are indexed (fast due lookup).
CREATE INDEX IF NOT EXISTS idx_profiles_deletion_grace
  ON public.profiles (deletion_grace_started_at)
  WHERE deletion_grace_started_at IS NOT NULL;

-- 4. Column grants: authenticated can read their own grace state (RLS
--    profiles_self_read limits rows to own id; column grant allows the
--    column to appear in the response). No UPDATE grant — only edge
--    functions (service_role) write these columns.
GRANT SELECT (deletion_grace_started_at) ON public.profiles TO authenticated;

-- 5. Atomic claim RPC — SECURITY DEFINER, service_role only.
--    Uses FOR UPDATE SKIP LOCKED so concurrent purge runs never claim the
--    same user twice. Sets deletion_purging_at as a claim marker.
CREATE OR REPLACE FUNCTION public.claim_due_deletions(p_limit int DEFAULT 10)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id
    FROM public.profiles
    WHERE deletion_grace_started_at IS NOT NULL
      AND deletion_grace_started_at <= now() - interval '30 days'
      AND deletion_purging_at IS NULL
    ORDER BY deletion_grace_started_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.profiles p
  SET deletion_purging_at = now()
  FROM due
  WHERE p.id = due.id
  RETURNING p.id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_due_deletions(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_deletions(int) TO service_role;

COMMENT ON FUNCTION public.claim_due_deletions(int) IS
  'Atomically claims users whose 30-day deletion grace has expired. '
  'Sets deletion_purging_at as a claim marker. FOR UPDATE SKIP LOCKED '
  'prevents concurrent purge runs from claiming the same user.';
