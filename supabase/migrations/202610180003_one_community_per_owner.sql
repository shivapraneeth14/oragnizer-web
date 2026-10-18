-- Migration: Enforce one live community per owner
-- Adds a partial unique index on communities.owner_id where deleted_at is null
-- Also includes a safe pre-flight to detect duplicates before creating the index
-- (if any found, the migration will fail with a clear message to clean them up)

DO $$
DECLARE
  dup_count integer;
BEGIN
  -- Detect owners with more than one live community
  WITH duplicates AS (
    SELECT owner_id, COUNT(*) AS cnt
    FROM communities
    WHERE deleted_at IS NULL
    GROUP BY owner_id
    HAVING COUNT(*) > 1
  )
  SELECT COUNT(*) INTO dup_count FROM duplicates;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Found % owner(s) with multiple live communities. Please resolve duplicates (keep one community per owner, soft-delete/merge the extras) before applying this migration.',
      dup_count;
  END IF;
END
$$;

-- Enforce at DB level: one live community per owner
CREATE UNIQUE INDEX IF NOT EXISTS idx_communities_owner_unique
  ON public.communities (owner_id)
  WHERE deleted_at IS NULL;
