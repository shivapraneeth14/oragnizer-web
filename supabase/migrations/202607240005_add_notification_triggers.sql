-- Helper: notify a single user
CREATE OR REPLACE FUNCTION notify_user()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN NEW;
END;
$$;

-- Notify all community members about a new event
CREATE OR REPLACE FUNCTION notify_new_event()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.notifications (user_id, type, title, body)
  SELECT cm.user_id, 'new_event', 'New event created',
         'A new event "' || NEW.title || '" has been posted.'
  FROM public.community_members cm
  WHERE cm.community_id = NEW.community_id AND cm.user_id != NEW.created_by;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_new_event
  AFTER INSERT ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION notify_new_event();

-- Notify all community members about a new community photo/video
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
  INSERT INTO public.notifications (user_id, type, title, body)
  SELECT cm.user_id, 'new_media', 'New ' || NEW.type || ' added',
         'A new ' || NEW.type || ' has been added to "' || v_community_name || '".'
  FROM public.community_members cm
  WHERE cm.community_id = NEW.mediable_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_new_community_media
  AFTER INSERT ON public.media
  FOR EACH ROW
  WHEN (NEW.mediable_type = 'community')
  EXECUTE FUNCTION notify_new_community_media();

-- Notify event registrant on successful registration
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
  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (NEW.user_id, 'registration_confirmed', 'Registration confirmed',
          'You are registered for "' || v_title || '".');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_registration
  AFTER INSERT ON public.registrations
  FOR EACH ROW
  WHEN (NEW.status = 'confirmed')
  EXECUTE FUNCTION notify_registration();

-- Notify registrants when event is cancelled
CREATE OR REPLACE FUNCTION notify_event_cancelled()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status != 'cancelled' THEN
    INSERT INTO public.notifications (user_id, type, title, body)
    SELECT r.user_id, 'event_cancelled', 'Event cancelled',
           'The event "' || NEW.title || '" has been cancelled.'
    FROM public.registrations r
    WHERE r.event_id = NEW.id AND r.status = 'confirmed' AND r.deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_event_cancelled
  AFTER UPDATE ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION notify_event_cancelled();
