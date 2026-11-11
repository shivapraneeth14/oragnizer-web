-- ============================================================================
-- CHIGZO — Harden delete_user_auth_cascade search_path
--
-- This was the only SECURITY DEFINER function not using SET search_path = ''.
-- It is service_role-only and already fully qualifies auth.users, so this is
-- defense-in-depth consistency with 202610120004. Body unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_user_auth_cascade(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_role text;
BEGIN
  IF v_claims IS NULL THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  v_role := (v_claims::jsonb ->> 'role')::text;
  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  DELETE FROM auth.users WHERE id = p_user_id;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_user_auth_cascade(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_user_auth_cascade(uuid) TO service_role;
