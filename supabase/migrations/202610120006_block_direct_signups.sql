-- ============================================================================
-- CLUVO - B2: block direct (unprovisioned) email/password signups at the door
--
-- Prior state (agent audit): Supabase Auth exposes a public /auth/v1/signup
-- endpoint and config.toml has `enable_signup = true`, so anyone holding the
-- app's public URL + anon key (both shipped in the clients) can create an
-- account WITHOUT going through the `register` edge function. That bypasses
-- consent capture, username/name validation and the password policy, and —
-- because `enable_confirmations = false` — the account is immediately usable.
-- The `handle_new_user` trigger then builds a profile from client-controlled
-- raw_user_meta_data (attacker picks their own username/name/avatar).
--
-- Fix: every account creation inserts a row into auth.users. A BEFORE INSERT
-- trigger inspects that row and rejects plain email/password signups that were
-- NOT provisioned by our own server. Our server-side creators (the `register`
-- and `seed-admin` edge functions) tag accounts with
-- app_metadata.cluvo_provisioned = true, which clients cannot set through the
-- public signup endpoint (it only accepts user-writable `data`).
--
-- Design: FAIL-OPEN. We reject only when the provider is explicitly 'email'
-- AND the stamp is absent. OAuth (Google) users, stamped server-created users,
-- and any unrecognised/absent provider all pass through — so legitimate signup,
-- Google login and admin seeding can never be locked out. Worst case is a
-- missed block, never a blocked real user.
--
-- Login, OAuth, password reset and existing users are untouched: this trigger
-- only fires on INSERT into auth.users (not on updates or sessions).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reject_unprovisioned_email_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- provider = 'email' is the GoTrue default for email/password signups.
  -- 'cluvo_provisioned' is only ever set by our service-role edge functions.
  IF (NEW.raw_app_meta_data->>'provider') = 'email'
     AND NEW.raw_app_meta_data->'cluvo_provisioned' IS DISTINCT FROM 'true'::jsonb
  THEN
    RAISE EXCEPTION 'Direct email/password signup is not allowed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger function is only an execution hook; no API role should call it directly.
REVOKE ALL ON FUNCTION public.reject_unprovisioned_email_signup() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_block_unprovisioned_email_signup ON auth.users;
CREATE TRIGGER trg_block_unprovisioned_email_signup
  BEFORE INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_unprovisioned_email_signup();
