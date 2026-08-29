-- check_in_registration RPC: verify QR code and mark attendance.
-- Called by the check-in edge function with service role privileges.

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
  -- Find registration by QR code
  SELECT r.id, r.event_id, r.user_id, r.status, r.checked_in, r.checked_in_at,
         e.title AS event_title, (e.status = 'cancelled') AS event_cancelled
  INTO v_reg
  FROM registrations r
  JOIN events e ON e.id = r.event_id
  WHERE r.qr_code = p_qr_code
    AND r.deleted_at IS NULL;

  -- QR not found
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Invalid QR code'::TEXT, NULL::TEXT, NULL::TEXT, NULL::UUID, NULL::UUID, FALSE;
    RETURN;
  END IF;

  -- Get attendee name
  SELECT COALESCE(first_name || ' ' || last_name, 'Unknown') INTO v_name
  FROM profiles WHERE id = v_reg.user_id;

  -- Event cancelled
  IF v_reg.event_cancelled THEN
    RETURN QUERY SELECT FALSE, 'Event cancelled'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
    RETURN;
  END IF;

  -- Registration cancelled
  IF v_reg.status = 'cancelled' THEN
    RETURN QUERY SELECT FALSE, 'Registration cancelled'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
    RETURN;
  END IF;

  -- Already checked in (must check before "not confirmed" since attended != confirmed)
  IF v_reg.checked_in THEN
    RETURN QUERY SELECT TRUE, 'Already checked in'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, TRUE;
    RETURN;
  END IF;

  -- Not confirmed
  IF v_reg.status != 'confirmed' THEN
    RETURN QUERY SELECT FALSE, 'Registration not confirmed'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
    RETURN;
  END IF;

  -- Check in: atomically set checked_in + status = attended
  UPDATE registrations
  SET checked_in = TRUE,
      checked_in_at = NOW(),
      status = 'attended',
      updated_at = NOW()
  WHERE id = v_reg.id;

  RETURN QUERY SELECT TRUE, 'Checked in successfully'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION check_in_registration(text) TO authenticated;

-- Index for fast QR code lookups during scanning
CREATE INDEX IF NOT EXISTS idx_registrations_qr_code ON registrations (qr_code) WHERE qr_code IS NOT NULL;
