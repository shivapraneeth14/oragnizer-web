-- Update the support/contact email returned to users blocked by a community in
-- closure grace: old Cluvo address -> Chigzo address.
--
-- Follow-up to 202610290001_block_members_of_closure_communities.sql. That
-- historical migration is left unedited (immutable history); this migration
-- replaces the live function with the corrected email.

CREATE OR REPLACE FUNCTION public.check_my_community_closure_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_community_name text;
  v_community_id uuid;
  v_is_admin boolean := false;
  v_role text := COALESCE((auth.jwt() ->> 'role'), '');
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  IF v_role = 'service_role' THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  SELECT public.is_admin_user() INTO v_is_admin;
  IF v_is_admin THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  SELECT c.id, c.name INTO v_community_id, v_community_name
  FROM public.community_members cm
  JOIN public.communities c ON c.id = cm.community_id
  WHERE cm.user_id = v_user_id
    AND c.deletion_grace_started_at IS NOT NULL
    AND c.closed_at IS NULL
  LIMIT 1;

  IF v_community_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'blocked', true,
      'community_id', v_community_id,
      'community_name', v_community_name,
      'contact_email', 'chigzo.app@gmail.com'
    );
  END IF;

  RETURN jsonb_build_object('blocked', false);
END;
$$;
