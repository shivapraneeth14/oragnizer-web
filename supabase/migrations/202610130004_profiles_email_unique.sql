-- Backstop: guarantee at most one profile per email address (case-insensitive).
--
-- Supabase Auth already enforces unique emails and merges same-email identities
-- into a single user, so duplicates should never occur. This index makes the
-- invariant impossible to violate at the database level as well, independent of
-- any future Auth/provider setting change.
--
-- Partial (WHERE deleted_at IS NULL) so a soft-deleted account does not block a
-- future account with the same address.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_email_unique
  ON public.profiles (lower(email))
  WHERE deleted_at IS NULL;
