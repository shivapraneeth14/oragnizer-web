-- G-05: allow administrative cleanup to update/delete cancelled events
--
-- The prevent_cancelled_event_updates trigger blocks any update to a row where
-- OLD.status = 'cancelled'. Admin community deletion (and other service-role
-- cleanup paths) must be able to update/cancel events as part of deletion.
-- Service role bypasses RLS, but triggers run regardless. Skip the guard when
-- the session user is service_role (auth.jwt() role) or when a deletion/cleanup
-- flag is explicitly passed via app settings (pg_temp.guc).

CREATE OR REPLACE FUNCTION public.prevent_cancelled_event_updates()
RETURNS TRIGGER AS $$
BEGIN
  -- Service role (edge functions using service key) must be able to clean up.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Explicit bypass for admin cleanup flows.
  BEGIN
    IF current_setting('app.allow_cancelled_event_cleanup', true) = 'true' THEN
      RETURN NEW;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      NULL;
  END;

  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot update a cancelled event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Helper to set GUC in current session (used by edge functions with service role)
CREATE OR REPLACE FUNCTION public.set_config(setting text, value text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM set_config(setting, value, true);
END;
$$;

REVOKE ALL ON FUNCTION public.set_config(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_config(text, text) TO service_role;
