-- Team Alerts: a passive "things broke" inbox for admins.
--
-- Written by background edge functions only (service_role). Admins read via
-- RLS (is_admin_user) and ack/resolve. Clients can never insert/delete.
-- No realtime, no publication, no coupling to payment/payout flows.

CREATE TABLE public.admin_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'critical')),
  category TEXT NOT NULL DEFAULT 'ops'
    CHECK (category IN ('ops', 'payout', 'payment', 'auth', 'community')),
  title TEXT NOT NULL,
  details JSONB,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Open alerts ordered newest-first — the query the portal badge/page uses.
CREATE INDEX idx_admin_alerts_status ON public.admin_alerts (status, created_at DESC);

ALTER TABLE public.admin_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_read_alerts ON public.admin_alerts
  FOR SELECT USING (public.is_admin_user());

CREATE POLICY admin_update_alerts ON public.admin_alerts
  FOR UPDATE USING (public.is_admin_user());

-- Portal sessions (authenticated, gated by is_admin_user in RLS) read + ack/resolve.
GRANT SELECT, UPDATE ON public.admin_alerts TO authenticated;
-- Edge functions write. No grants to anon — authenticated has no INSERT policy.
GRANT ALL ON public.admin_alerts TO service_role;

-- resolved_at is always accurate: auto-filled the moment an admin resolves.
CREATE OR REPLACE FUNCTION public.set_admin_alert_resolved_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'resolved' AND NEW.resolved_at IS NULL THEN
    NEW.resolved_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_admin_alerts_resolved_at
  BEFORE UPDATE ON public.admin_alerts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_admin_alert_resolved_at();