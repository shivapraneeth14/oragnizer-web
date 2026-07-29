CREATE TABLE IF NOT EXISTS rate_limits (
  id BIGSERIAL PRIMARY KEY,
  identifier TEXT NOT NULL,
  action TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup ON rate_limits (identifier, action, window_start DESC);

CREATE OR REPLACE FUNCTION check_rate_limit(
  p_identifier TEXT,
  p_action TEXT,
  p_max_requests INT DEFAULT 30,
  p_window_seconds INT DEFAULT 60
) RETURNS BOOLEAN AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_current_count INT;
BEGIN
  v_window_start := date_trunc('second', NOW()) - (p_window_seconds * INTERVAL '1 second');

  SELECT COUNT(*) INTO v_current_count
  FROM rate_limits
  WHERE identifier = p_identifier
    AND action = p_action
    AND window_start > v_window_start;

  IF v_current_count >= p_max_requests THEN
    RETURN FALSE;
  END IF;

  INSERT INTO rate_limits (identifier, action, window_start, count)
  VALUES (p_identifier, p_action, NOW(), 1);

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION check_rate_limit_strict(
  p_identifier TEXT,
  p_action TEXT,
  p_max_requests INT DEFAULT 5,
  p_window_seconds INT DEFAULT 60
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN check_rate_limit(p_identifier, p_action, p_max_requests, p_window_seconds);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
