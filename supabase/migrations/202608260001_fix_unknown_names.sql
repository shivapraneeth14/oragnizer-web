-- Fix "Unknown" names for Google OAuth users.
-- 1. Update trigger to read Google metadata keys as fallback
-- 2. Backfill existing users with NULL names
-- 3. Add username fallback to check_in_registration RPC

-- 1. Fix trigger
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, first_name, last_name, username, avatar_url)
  VALUES (
    new.id,
    new.email,
    COALESCE(
      new.raw_user_meta_data->>'first_name',
      new.raw_user_meta_data->>'given_name',
      split_part(new.raw_user_meta_data->>'name', ' ', 1)
    ),
    COALESCE(
      new.raw_user_meta_data->>'last_name',
      new.raw_user_meta_data->>'family_name',
      CASE WHEN position(' ' in coalesce(new.raw_user_meta_data->>'name', '')) > 0
           THEN trim(substring(new.raw_user_meta_data->>'name' from position(' ' in new.raw_user_meta_data->>'name') + 1))
           ELSE '' END
    ),
    new.raw_user_meta_data->>'username',
    COALESCE(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Backfill existing users with NULL names
UPDATE profiles p
SET
  first_name = COALESCE(
    (SELECT raw_user_meta_data->>'first_name' FROM auth.users u WHERE u.id = p.id),
    (SELECT raw_user_meta_data->>'given_name' FROM auth.users u WHERE u.id = p.id),
    split_part((SELECT raw_user_meta_data->>'name' FROM auth.users u WHERE u.id = p.id), ' ', 1)
  ),
  last_name = COALESCE(
    (SELECT raw_user_meta_data->>'last_name' FROM auth.users u WHERE u.id = p.id),
    (SELECT raw_user_meta_data->>'family_name' FROM auth.users u WHERE u.id = p.id),
    CASE WHEN position(' ' in coalesce((SELECT raw_user_meta_data->>'name' FROM auth.users u WHERE u.id = p.id), '')) > 0
         THEN trim(substring((SELECT raw_user_meta_data->>'name' FROM auth.users u WHERE u.id = p.id) from position(' ' in (SELECT raw_user_meta_data->>'name' FROM auth.users u WHERE u.id = p.id)) + 1))
         ELSE '' END
  )
WHERE p.first_name IS NULL AND p.last_name IS NULL;

-- 3. Updated RPC with username fallback
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
         e.title AS event_title, (e.status = 'cancelled') AS event_cancelled
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

  IF v_reg.checked_in THEN
    RETURN QUERY SELECT TRUE, 'Already checked in'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, TRUE;
    RETURN;
  END IF;

  IF v_reg.status != 'confirmed' THEN
    RETURN QUERY SELECT FALSE, 'Registration not confirmed'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
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

GRANT EXECUTE ON FUNCTION check_in_registration(text) TO authenticated;
