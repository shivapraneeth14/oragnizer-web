-- Users who registered for an event can always read that event, even after it
-- is cancelled (events_public_read only exposes 'published' events, which hides
-- cancelled events from the profile -> Registrations tab and the Payments tab).
CREATE POLICY "events_registered_read" ON events FOR SELECT USING (
  id IN (SELECT event_id FROM registrations WHERE user_id = auth.uid())
);
