-- The previous events_registered_read policy queried registrations directly,
-- which triggered registrations_team_read -> events RLS -> back to this policy,
-- causing "infinite recursion detected in policy for relation events" for any
-- logged-in query touching events. Replace it with a SECURITY DEFINER function
-- that reads registrations without re-entering RLS.
DROP POLICY IF EXISTS "events_registered_read" ON events;

CREATE OR REPLACE FUNCTION public.is_registered_for_event(event_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS
$$ SELECT EXISTS (
     SELECT 1 FROM public.registrations
     WHERE event_id = $1 AND user_id = auth.uid()
   ) $$;

REVOKE ALL ON FUNCTION public.is_registered_for_event(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_registered_for_event(uuid) TO authenticated;

CREATE POLICY "events_registered_read" ON events FOR SELECT
USING (public.is_registered_for_event(id));
