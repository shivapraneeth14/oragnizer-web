-- Check-in security:
-- 1. Restrict the RPC to the check-in edge function (service role). Clients
--    must no longer be able to call check_in_registration directly, which
--    previously bypassed the edge function's authorization.
-- 2. Reject check-ins for events whose end_date has already passed.
--
-- The authorization decision itself lives in the check-in edge function, which
-- runs this RPC with the service role only after verifying the caller manages
-- the event's community.

CREATE OR REPLACE FUNCTION check_in_registration(p_qr_code TEXT)
RETURNS TABLE (
  success BOOLEAN,
  message TEXT,
  attendee_name TEXT,
  event_title TEXT,
  event_id UUID,
  registration_id UUID,
  already_checked_in BOOLEAN
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_reg RECORD;
  v_name TEXT;
BEGIN
  SELECT r.id, r.event_id, r.user_id, r.status, r.checked_in, r.checked_in_at,
         e.title AS event_title, (e.status = 'cancelled') AS event_cancelled,
         e.end_date AS event_end
  INTO v_reg
  FROM registrations r
  JOIN events e ON e.id = r.event_id
  WHERE r.qr_code = p_qr_code
    AND r.deleted_at IS NULL;

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
  FROM profiles WHERE id = v_reg.user_id;

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

  UPDATE registrations
  SET checked_in = TRUE,
      checked_in_at = NOW(),
      status = 'attended',
      updated_at = NOW()
  WHERE id = v_reg.id;

  RETURN QUERY SELECT TRUE, 'Checked in successfully'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_in_registration(text) FROM authenticated, anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_in_registration(text) TO service_role;
