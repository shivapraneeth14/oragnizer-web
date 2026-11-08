-- ============================================================================
-- CLUVO — Ticket credential safety
--
-- 1. Event cancellation must invalidate every ticket the moment it starts,
--    not when the background worker eventually reaches each registration.
--    A trigger on events.status -> 'cancelling' clears qr_code for the event.
-- 2. Check-in now rejects an event that is 'cancelling' (previously only
--    'cancelled'), closing the free-entry window.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.clear_event_qr_on_cancelling()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'cancelling' AND COALESCE(OLD.status, '') <> 'cancelling' THEN
    UPDATE public.registrations
    SET qr_code = NULL,
        updated_at = clock_timestamp()
    WHERE event_id = NEW.id
      AND qr_code IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_event_qr_on_cancelling ON public.events;
CREATE TRIGGER trg_clear_event_qr_on_cancelling
AFTER UPDATE OF status ON public.events
FOR EACH ROW EXECUTE FUNCTION public.clear_event_qr_on_cancelling();

-- ----------------------------------------------------------------------------
-- check_in_registration — reject both cancelling and cancelled events.
-- Everything else is unchanged from 202610300002.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_in_registration(p_qr_code TEXT)
RETURNS TABLE (
  success BOOLEAN,
  message TEXT,
  attendee_name TEXT,
  event_title TEXT,
  event_id UUID,
  registration_id UUID,
  already_checked_in BOOLEAN
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_reg RECORD;
  v_name TEXT;
  v_updated_id UUID;
BEGIN
  SELECT r.id, r.event_id, r.user_id, r.status, r.checked_in, r.checked_in_at,
         e.title AS event_title, (e.status IN ('cancelled', 'cancelling')) AS event_cancelled,
         e.end_date AS event_end
  INTO v_reg
  FROM public.registrations r
  JOIN public.events e ON e.id = r.event_id
  WHERE r.qr_code = p_qr_code
    AND r.deleted_at IS NULL
  FOR UPDATE OF r;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Invalid QR code'::TEXT, NULL::TEXT, NULL::TEXT, NULL::UUID, NULL::UUID, FALSE;
    RETURN;
  END IF;

  SELECT COALESCE(
    NULLIF(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), ''),
    username,
    'Unknown'
  ) INTO v_name
  FROM public.profiles WHERE id = v_reg.user_id;

  IF v_reg.event_cancelled THEN
    RETURN QUERY SELECT FALSE, 'Event cancelled'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
    RETURN;
  END IF;

  IF v_reg.status = 'cancelled' THEN
    RETURN QUERY SELECT FALSE, 'Registration cancelled'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
    RETURN;
  END IF;

  IF v_reg.checked_in THEN
    RETURN QUERY SELECT TRUE, 'Already checked in'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, TRUE;
    RETURN;
  END IF;

  IF v_reg.status != 'confirmed' THEN
    RETURN QUERY SELECT FALSE, 'Registration not confirmed'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
    RETURN;
  END IF;

  IF v_reg.event_end IS NOT NULL AND v_reg.event_end < NOW() THEN
    RETURN QUERY SELECT FALSE, 'Event has ended'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
    RETURN;
  END IF;

  UPDATE public.registrations
  SET checked_in = TRUE,
      checked_in_at = NOW(),
      status = 'attended',
      updated_at = NOW()
  WHERE id = v_reg.id
    AND checked_in = FALSE
  RETURNING id INTO v_updated_id;

  IF v_updated_id IS NULL THEN
    RETURN QUERY SELECT TRUE, 'Already checked in'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, TRUE;
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'Checked in successfully'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.check_in_registration(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_in_registration(text) TO service_role;
