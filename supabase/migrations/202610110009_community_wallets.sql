-- ============================================================================
-- CLUVO — Community wallets (Phase 3.3)
--
-- The community_wallets table tracks per-community balances for refunds,
-- payouts, and platform fee retention. RLSc restricts client access; only
-- service_role (edge functions) may read/write.
-- ============================================================================

-- Create community_wallets table
CREATE TABLE IF NOT EXISTS public.community_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  UNIQUE (community_id),
  CHECK (balance >= 0)
);

-- Add foreign key reference to communities
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'community_wallets_community_id_fkey'
      AND table_name = 'community_wallets'
  ) THEN
    ALTER TABLE public.community_wallets
      ADD CONSTRAINT community_wallets_community_id_fkey
      FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
  END IF;
END
$$;

-- Enable RLS and restrict client access
ALTER TABLE public.community_wallets ENABLE ROW LEVEL SECURITY;

-- Revoke all client roles; grant service_role full access
REVOKE ALL ON TABLE public.community_wallets FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.community_wallets TO service_role;
