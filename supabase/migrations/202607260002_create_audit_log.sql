CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES profiles(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_read_audit_log" ON audit_log;
CREATE POLICY "admin_read_audit_log" ON audit_log
  FOR SELECT USING (public.is_admin_user());

DROP POLICY IF EXISTS "insert_audit_log" ON audit_log;
CREATE POLICY "insert_audit_log" ON audit_log
  FOR INSERT WITH CHECK (true);
