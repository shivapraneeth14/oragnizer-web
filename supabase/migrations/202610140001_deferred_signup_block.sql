-- ============================================================================
-- CLUVO - B2b: make the direct-signup block see GoTrue's server-side stamp
--
-- 202610120006 added a BEFORE INSERT trigger on auth.users that rejects
-- email/password signups lacking app_metadata.cluvo_provisioned. In practice it
-- rejected everything, including our own server-provisioned signups: GoTrue
-- (auth v2.197) does NOT include the caller's app_metadata in the initial
-- INSERT. For admin.createUser it builds the row with only the default
-- provider/providers, then applies the caller's app_metadata in a follow-up
-- UPDATE *inside the same transaction* (supabase/auth internal/api/admin.go:
-- db.Transaction { tx.Create(user); ... user.UpdateAppMetaData(...) }). A BEFORE
-- INSERT trigger therefore never saw cluvo_provisioned and blocked every email
-- registration on TEST and PROD.
--
-- Fix: move the check to a DEFERRABLE INITIALLY DEFERRED constraint trigger
-- that fires at COMMIT and re-reads the row's FINAL raw_app_meta_data, so:
--   * admin.createUser / seed-admin -> stamp present at commit -> allowed
--   * public /auth/v1/signup        -> provider='email', no stamp -> rejected
--   * Google OAuth                  -> provider='google'          -> allowed
-- The public signup path writes provider='email' into the row from the start
-- (SignupParams.ToUserModel) and no public caller can set app_metadata, so the
-- rejection still lands inside the same transaction and rolls the signup back.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reject_unprovisioned_email_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_app jsonb;
BEGIN
  -- Re-read the row's final state at COMMIT: the server-side stamp is applied
  -- by a later UPDATE in the same transaction, so NEW (the insert-time tuple)
  -- is not authoritative.
  SELECT raw_app_meta_data INTO v_app FROM auth.users WHERE id = NEW.id;

  -- Row removed before commit (or never really present): nothing to guard.
  IF v_app IS NULL THEN
    RETURN NULL;
  END IF;

  IF (v_app->>'provider') = 'email'
     AND v_app->'cluvo_provisioned' IS DISTINCT FROM 'true'::jsonb
  THEN
    RAISE EXCEPTION 'Direct email/password signup is not allowed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NULL;
END;
$$;

-- Trigger function is only an execution hook; no API role should call it directly.
REVOKE ALL ON FUNCTION public.reject_unprovisioned_email_signup() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_block_unprovisioned_email_signup ON auth.users;
CREATE CONSTRAINT TRIGGER trg_block_unprovisioned_email_signup
  AFTER INSERT ON auth.users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_unprovisioned_email_signup();
