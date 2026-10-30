-- ============================================================================
-- CLUVO — Community Applications, Review & Approval Workflow
--
-- 1. Create public.community_applications staging table:
--    - Stores new community requests in 'pending' status before platform admin approval.
--    - Keeps unapproved communities completely isolated from public discovery and mobile apps.
--    - Tracks rejection reasons, audit trail, and reviewer references.
--
-- 2. Deploy admin_approve_community_application RPC:
--    - Atomic promotion: creates row in public.communities and community_members as 'OWNER'.
--    - Marks application as 'approved' and links the community_id.
--    - Gated strictly by public.is_admin_user().
--
-- 3. Deploy admin_reject_community_application RPC:
--    - Marks application as 'rejected' with mandatory admin feedback/reason.
--    - Gated strictly by public.is_admin_user().
--
-- 4. Deploy get_admin_community_applications RPC:
--    - High-performance directory of applications with applicant profiles for admin portal.
-- ============================================================================

-- 1. Create public.community_applications table
CREATE TABLE IF NOT EXISTS public.community_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  community_name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  country TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  rules TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  community_id UUID REFERENCES public.communities(id) ON DELETE SET NULL,
  reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performance and uniqueness
CREATE INDEX IF NOT EXISTS idx_community_applications_user
  ON public.community_applications (user_id);

CREATE INDEX IF NOT EXISTS idx_community_applications_status_pending
  ON public.community_applications (created_at DESC)
  WHERE status = 'pending';

-- Prevent concurrent duplicate applications for the same community name while pending
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_applications_uniq_name_pending
  ON public.community_applications (LOWER(TRIM(community_name)))
  WHERE status = 'pending';

-- Prevent concurrent duplicate applications for the same contact email while pending
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_applications_uniq_email_pending
  ON public.community_applications (LOWER(TRIM(contact_email)))
  WHERE status = 'pending';

-- Enable Row Level Security
ALTER TABLE public.community_applications ENABLE ROW LEVEL SECURITY;

-- Applicants can SELECT their own applications
DROP POLICY IF EXISTS "community_applications_applicant_select" ON public.community_applications;
CREATE POLICY "community_applications_applicant_select"
  ON public.community_applications
  FOR SELECT
  USING (auth.uid() = user_id);

-- Applicants can INSERT their own application
DROP POLICY IF EXISTS "community_applications_applicant_insert" ON public.community_applications;
CREATE POLICY "community_applications_applicant_insert"
  ON public.community_applications
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Applicants can UPDATE their own rejected applications to re-submit
DROP POLICY IF EXISTS "community_applications_applicant_update" ON public.community_applications;
CREATE POLICY "community_applications_applicant_update"
  ON public.community_applications
  FOR UPDATE
  USING (auth.uid() = user_id AND status = 'rejected')
  WITH CHECK (auth.uid() = user_id);

-- Admins have full access to view, update, and manage all applications
DROP POLICY IF EXISTS "community_applications_admin_all" ON public.community_applications;
CREATE POLICY "community_applications_admin_all"
  ON public.community_applications
  FOR ALL
  USING (public.is_admin_user());

-- Column grants
GRANT SELECT, INSERT, UPDATE ON public.community_applications TO authenticated;
GRANT ALL ON public.community_applications TO service_role;

-- 2. Deploy admin_approve_community_application RPC
CREATE OR REPLACE FUNCTION public.admin_approve_community_application(
  p_application_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_app RECORD;
  v_community_id UUID;
  v_existing_owner UUID;
BEGIN
  -- Strict privilege check: must be platform admin
  IF NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Unauthorized: Admin privileges required.');
  END IF;

  -- Lock the application record
  SELECT * INTO v_app
  FROM public.community_applications
  WHERE id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Application not found.');
  END IF;

  IF v_app.status != 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Application is not in pending state (currently ' || v_app.status || ').');
  END IF;

  -- Verify user does not already own a live community
  SELECT id INTO v_existing_owner
  FROM public.communities
  WHERE owner_id = v_app.user_id AND deleted_at IS NULL
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'User already owns an active community.');
  END IF;

  -- Check if community name is taken by an active community
  IF EXISTS (
    SELECT 1 FROM public.communities
    WHERE LOWER(TRIM(name)) = LOWER(TRIM(v_app.community_name))
      AND deleted_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A community with this name already exists.');
  END IF;

  -- 1. Insert into public.communities
  INSERT INTO public.communities (
    name,
    description,
    category,
    city,
    state,
    country,
    contact_email,
    contact_phone,
    tags,
    rules,
    owner_id,
    visibility,
    verification_status
  ) VALUES (
    TRIM(v_app.community_name),
    TRIM(v_app.description),
    TRIM(v_app.category),
    TRIM(v_app.city),
    TRIM(v_app.state),
    TRIM(v_app.country),
    TRIM(v_app.contact_email),
    TRIM(v_app.contact_phone),
    v_app.tags,
    TRIM(v_app.rules),
    v_app.user_id,
    'public',
    'verified'
  )
  RETURNING id INTO v_community_id;

  -- 2. Insert into public.community_members as OWNER
  INSERT INTO public.community_members (
    community_id,
    user_id,
    role
  ) VALUES (
    v_community_id,
    v_app.user_id,
    'OWNER'
  );

  -- 3. Update application record
  UPDATE public.community_applications
  SET status = 'approved',
      community_id = v_community_id,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  WHERE id = p_application_id;

  -- 4. Audit Log
  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('community_application_approved', jsonb_build_object(
    'application_id', p_application_id,
    'community_id', v_community_id,
    'community_name', v_app.community_name,
    'owner_id', v_app.user_id,
    'admin_id', auth.uid()
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'application_id', p_application_id,
    'community_id', v_community_id,
    'community_name', v_app.community_name,
    'owner_id', v_app.user_id,
    'status', 'approved'
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_approve_community_application(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_community_application(UUID) TO authenticated, service_role;

-- 3. Deploy admin_reject_community_application RPC
CREATE OR REPLACE FUNCTION public.admin_reject_community_application(
  p_application_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_app RECORD;
BEGIN
  -- Strict privilege check: must be platform admin
  IF NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Unauthorized: Admin privileges required.');
  END IF;

  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A rejection reason is required.');
  END IF;

  -- Lock the application record
  SELECT * INTO v_app
  FROM public.community_applications
  WHERE id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Application not found.');
  END IF;

  IF v_app.status != 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Application is not in pending state.');
  END IF;

  -- Update application record
  UPDATE public.community_applications
  SET status = 'rejected',
      rejection_reason = TRIM(p_reason),
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  WHERE id = p_application_id;

  -- Audit Log
  INSERT INTO public.payment_audit_log (action, details)
  VALUES ('community_application_rejected', jsonb_build_object(
    'application_id', p_application_id,
    'community_name', v_app.community_name,
    'owner_id', v_app.user_id,
    'rejection_reason', TRIM(p_reason),
    'admin_id', auth.uid()
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'application_id', p_application_id,
    'status', 'rejected'
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_reject_community_application(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reject_community_application(UUID, TEXT) TO authenticated, service_role;

-- 4. Deploy get_admin_community_applications RPC
CREATE OR REPLACE FUNCTION public.get_admin_community_applications()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSONB;
BEGIN
  -- Strict privilege check: must be platform admin
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Unauthorized: Only platform administrators can view community applications.';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', ca.id,
      'user_id', ca.user_id,
      'community_name', ca.community_name,
      'category', ca.category,
      'description', ca.description,
      'city', ca.city,
      'state', ca.state,
      'country', ca.country,
      'contact_email', ca.contact_email,
      'contact_phone', ca.contact_phone,
      'tags', ca.tags,
      'rules', ca.rules,
      'status', ca.status,
      'rejection_reason', ca.rejection_reason,
      'community_id', ca.community_id,
      'reviewed_by', ca.reviewed_by,
      'reviewed_at', ca.reviewed_at,
      'created_at', ca.created_at,
      'updated_at', ca.updated_at,
      'applicant_name', COALESCE(
        NULLIF(TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')), ''),
        NULLIF(p.username, ''),
        p.email,
        'Applicant'
      ),
      'applicant_email', p.email,
      'applicant_username', p.username
    )
    ORDER BY ca.created_at DESC
  ), '[]'::JSONB)
  INTO v_result
  FROM public.community_applications ca
  LEFT JOIN public.profiles p ON p.id = ca.user_id;

  RETURN v_result;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_admin_community_applications() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_community_applications() TO authenticated, service_role;

