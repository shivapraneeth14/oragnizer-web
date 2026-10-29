-- Atomic check-in race condition fix (AUTH-001):
-- 1. Lock the registration row with FOR UPDATE OF r so concurrent scans serialize.
-- 2. Use a conditional UPDATE ... WHERE id = v_reg.id AND checked_in = FALSE
--    with RETURNING id to ensure first-writer-wins semantics.
-- 3. Maintain SECURITY DEFINER SET search_path = '' and service_role-only privileges.

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
  -- Lock the registration row to serialize concurrent scans for the same ticket
  SELECT r.id, r.event_id, r.user_id, r.status, r.checked_in, r.checked_in_at,
         e.title AS event_title, (e.status = 'cancelled') AS event_cancelled,
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

  -- Get name: first_name + last_name, fallback to username, fallback to Unknown
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

  -- Checked-in state is reported before the ended check so a re-scan still
  -- shows "Already checked in" after the event ends.
  IF v_reg.checked_in THEN
    RETURN QUERY SELECT TRUE, 'Already checked in'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, TRUE;
    RETURN;
  END IF;

  IF v_reg.status != 'confirmed' THEN
    RETURN QUERY SELECT FALSE, 'Registration not confirmed'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
    RETURN;
  END IF;

  -- No check-ins once the event has ended.
  IF v_reg.event_end IS NOT NULL AND v_reg.event_end < NOW() THEN
    RETURN QUERY SELECT FALSE, 'Event has ended'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
    RETURN;
  END IF;

  -- Atomic conditional update: only update if checked_in is still FALSE.
  -- Guarantees exactly one scanner succeeds even under concurrent calls.
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

