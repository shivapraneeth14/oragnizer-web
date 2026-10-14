-- ============================================================================
-- CLUVO — Auth redesign: authoritative "does this account have a password?"
--
-- The email-first entry point (edge function `check-account`) must decide
-- whether to ask for a password or route the user through Google. Identities
-- alone are not authoritative: a user can carry both a Google and an email
-- identity, and GoTrue may create an email identity without a usable password.
-- The only reliable signal is auth.users.encrypted_password.
--
-- auth.users is not readable by anon/authenticated, and the column is
-- sensitive, so this is a SECURITY DEFINER function that reads it directly and
-- is executable ONLY by service_role (edge functions). Clients can never call
-- it, so it cannot be used as a password-presence oracle.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.user_has_password(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.users
    WHERE id = p_user_id
      AND COALESCE(encrypted_password, '') <> ''
  );
$$;

-- Lock execution down to the service role only.
REVOKE ALL ON FUNCTION public.user_has_password(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_password(uuid) TO service_role;
