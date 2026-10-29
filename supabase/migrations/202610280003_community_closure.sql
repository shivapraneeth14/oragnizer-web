-- Community closure instead of deletion (preserve row for financial integrity)
ALTER TABLE public.communities
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_hidden_before_deletion BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_communities_closed_at ON public.communities (closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_communities_closure_grace ON public.communities (deletion_grace_started_at) WHERE deletion_grace_started_at IS NOT NULL AND closed_at IS NULL;

-- Column grants: authenticated can read closure and visibility-before-deletion states
GRANT SELECT (closed_at, is_hidden_before_deletion) ON public.communities TO authenticated;
