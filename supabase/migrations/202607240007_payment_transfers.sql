CREATE TABLE payment_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id),
  community_id UUID NOT NULL REFERENCES communities(id),
  razorpay_transfer_id TEXT UNIQUE,
  amount INTEGER NOT NULL,
  commission_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processed', 'failed', 'reversed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transfers_by_payment ON payment_transfers(payment_id);
CREATE INDEX idx_transfers_pending ON payment_transfers(status) WHERE status = 'pending';

ALTER TABLE payment_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "transfer_team_read" ON payment_transfers FOR SELECT
  USING (is_community_owner(community_id) OR is_community_member(community_id));

CREATE POLICY "admin_read_all_transfers" ON payment_transfers FOR SELECT
  USING (public.is_admin_user());

CREATE TABLE payment_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  payment_id UUID REFERENCES payments(id),
  transfer_id UUID REFERENCES payment_transfers(id),
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_payment ON payment_audit_log(payment_id);
CREATE INDEX idx_audit_log_created ON payment_audit_log(created_at);

ALTER TABLE payment_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_audit_log" ON payment_audit_log
  FOR SELECT USING (public.is_admin_user());

ALTER TABLE payments ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER trg_payment_transfers_updated
  BEFORE UPDATE ON payment_transfers
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
