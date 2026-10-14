-- ============================================================================
-- CLUVO - A5: harden SECURITY DEFINER functions against search_path hijacking
--
-- Prior state (agent audit): five definer functions relied on the caller's
-- session search_path to resolve unqualified objects:
--   check_in_registration, check_rate_limit, check_rate_limit_strict,
--   handle_new_user, is_admin_user.
-- A caller who can set search_path (e.g. public schema is writable for the
-- authenticated role) could shadow `registrations`/`rate_limits`/`profiles`
-- with a hostile table BEFORE calling the definer function, which then runs
-- with the auto-executed-privileged owner and no reset search_path.
--
-- Fix: recreate each body with SET search_path = '' (only pg_catalog is then
-- implicitly searched) AND fully schema-qualify every user object reference.
-- Identical signatures, return types, volatility and defaults — so the
-- EXECUTE grants made in 202610110001 (service_role only) still bind.
--
-- Behavior after deploy is identical (functions resolve the same public
-- objects); only the lookup mechanics change. No released-client impact.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. check_in_registration (202610090001 body, qualified)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_in_registration(p_qr_code TEXT)
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
BEGIN
  SELECT r.id, r.event_id, r.user_id, r.status, r.checked_in, r.checked_in_at,
         e.title AS event_title, (e.status = 'cancelled') AS event_cancelled,
         e.end_date AS event_end
  INTO v_reg
  FROM public.registrations r
  JOIN public.events e ON e.id = r.event_id
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

  UPDATE public.registrations
  SET checked_in = TRUE,
      checked_in_at = NOW(),
      status = 'attended',
      updated_at = NOW()
  WHERE id = v_reg.id;

  RETURN QUERY SELECT TRUE, 'Checked in successfully'::TEXT, v_name, v_reg.event_title, v_reg.event_id, v_reg.id, FALSE;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. check_rate_limit / check_rate_limit_strict (202607260001 body, qualified)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_identifier TEXT,
  p_action TEXT,
  p_max_requests INT DEFAULT 30,
  p_window_seconds INT DEFAULT 60
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_current_count INT;
BEGIN
  v_window_start := date_trunc('second', NOW()) - (p_window_seconds * INTERVAL '1 second');

  SELECT COUNT(*) INTO v_current_count
  FROM public.rate_limits
  WHERE identifier = p_identifier
    AND action = p_action
    AND window_start > v_window_start;

  IF v_current_count >= p_max_requests THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.rate_limits (identifier, action, window_start, count)
  VALUES (p_identifier, p_action, NOW(), 1);

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION check_rate_limit_strict(
  p_identifier TEXT,
  p_action TEXT,
  p_max_requests INT DEFAULT 5,
  p_window_seconds INT DEFAULT 60
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN public.check_rate_limit(p_identifier, p_action, p_max_requests, p_window_seconds);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. handle_new_user trigger (202608260001 body, qualified)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
$$;

-- ---------------------------------------------------------------------------
-- 4. is_admin_user RLS helper (202607230009 body, qualified)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true
  );
$$;