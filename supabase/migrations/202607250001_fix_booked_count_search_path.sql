-- Fix: increment_event_booked RPC had SET search_path = '' but used unqualified
-- table names, causing "relation events does not exist" (42P01).
CREATE OR REPLACE FUNCTION increment_event_booked(p_event_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_capacity INTEGER;
  v_booked INTEGER;
  v_updated INTEGER;
BEGIN
  SELECT capacity, booked_count INTO v_capacity, v_booked
  FROM public.events WHERE id = p_event_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Event not found');
  END IF;

  UPDATE public.events SET booked_count = booked_count + 1
  WHERE id = p_event_id
    AND (capacity IS NULL OR booked_count < capacity);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object('error', 'Event is full');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;
