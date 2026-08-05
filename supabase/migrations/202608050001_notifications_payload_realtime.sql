-- In-app notifications: add navigation payload to the DB triggers + enable
-- realtime so the app can show new notifications without a manual refresh.
-- New payload shape: {"type":"event"|"community","id":<uuid>}.
-- Notifications created by payment flows carry {"event_id":...} instead;
-- the app resolves both.

CREATE OR REPLACE FUNCTION notify_new_event()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.notifications (user_id, type, title, body, payload)
  SELECT cm.user_id, 'new_event', 'New event created',
         'A new event "' || NEW.title || '" has been posted.',
         jsonb_build_object('type', 'event', 'id', NEW.id)
  FROM public.community_members cm
  WHERE cm.community_id = NEW.community_id AND cm.user_id != NEW.created_by;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION notify_new_community_media()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_community_name text;
BEGIN
  SELECT name INTO v_community_name FROM public.communities WHERE id = NEW.mediable_id;
  INSERT INTO public.notifications (user_id, type, title, body, payload)
  SELECT cm.user_id, 'new_media', 'New ' || NEW.type || ' added',
         'A new ' || NEW.type || ' has been added to "' || v_community_name || '".',
         jsonb_build_object('type', 'community', 'id', NEW.mediable_id)
  FROM public.community_members cm
  WHERE cm.community_id = NEW.mediable_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION notify_registration()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_title text;
BEGIN
  SELECT title INTO v_title FROM public.events WHERE id = NEW.event_id;
  INSERT INTO public.notifications (user_id, type, title, body, payload)
  VALUES (NEW.user_id, 'registration_confirmed', 'Registration confirmed',
          'You are registered for "' || v_title || '".',
          jsonb_build_object('type', 'event', 'id', NEW.event_id));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION notify_event_cancelled()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status != 'cancelled' THEN
    INSERT INTO public.notifications (user_id, type, title, body, payload)
    SELECT r.user_id, 'event_cancelled', 'Event cancelled',
           'The event "' || NEW.title || '" has been cancelled.',
           jsonb_build_object('type', 'event', 'id', NEW.id)
    FROM public.registrations r
    WHERE r.event_id = NEW.id AND r.status = 'confirmed' AND r.deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Realtime: the app subscribes to postgres_changes on notifications; RLS
-- (self-only) keeps each subscriber limited to their own rows.
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
