-- ============================================================================
-- CLUVO — Re-grant community deletion grace and closure columns to authenticated
--
-- Restores SELECT grants on deletion_grace_started_at, is_hidden_before_deletion,
-- and closed_at which were revoked by 202610290005's REVOKE SELECT.
-- ============================================================================

GRANT SELECT (
  deletion_grace_started_at,
  is_hidden_before_deletion,
  closed_at
) ON public.communities TO authenticated;
