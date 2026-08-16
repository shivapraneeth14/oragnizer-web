-- CLUVO - EVENTS + REGISTRATIONS REALTIME (2026-08-10)
--
-- Lets the mobile app receive event changes (create/update/delete, e.g. a
-- cancellation or a seat being taken) and registration changes (e.g. a webhook
-- confirming a payment) without any manual refresh. RLS still gates every
-- postgres_changes message a client receives - this only adds the tables to
-- the publication, same as the existing event_messages/notifications setup.

ALTER PUBLICATION supabase_realtime ADD TABLE events;
ALTER PUBLICATION supabase_realtime ADD TABLE registrations;