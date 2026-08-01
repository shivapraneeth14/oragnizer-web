CREATE TABLE IF NOT EXISTS community_beneficiaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  cashfree_beneficiary_id TEXT NOT NULL,
  account_holder TEXT NOT NULL,
  bank_account_number TEXT NOT NULL,
  bank_ifsc TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_beneficiary
  ON community_beneficiaries(community_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_beneficiaries_community
  ON community_beneficiaries(community_id);

ALTER TABLE community_beneficiaries ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'community_beneficiaries' AND policyname = 'owner_manage_beneficiaries'
  ) THEN
    CREATE POLICY "owner_manage_beneficiaries" ON community_beneficiaries
      FOR ALL USING (public.is_community_owner(community_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'community_beneficiaries' AND policyname = 'admin_read_all_beneficiaries'
  ) THEN
    CREATE POLICY "admin_read_all_beneficiaries" ON community_beneficiaries
      FOR SELECT USING (public.is_admin_user());
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_community_beneficiaries_updated ON community_beneficiaries;
CREATE TRIGGER trg_community_beneficiaries_updated
  BEFORE UPDATE ON community_beneficiaries
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE payout_items
  ADD COLUMN IF NOT EXISTS beneficiary_id UUID REFERENCES community_beneficiaries(id);
