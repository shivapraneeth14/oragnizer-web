-- Block members/owners of communities scheduled for closure (grace period) from accessing the app
-- Admins and service role are exempt. This is separate from user account deletion.

-- Helper: is current user an admin?
CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_admin = true
  );
$$;

-- Check if a given user is a member/owner of any community in closure grace (and not admin)
CREATE OR REPLACE FUNCTION public.is_member_of_closure_community(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.community_members cm
    JOIN public.communities c ON c.id = cm.community_id
    WHERE cm.user_id = COALESCE(p_user_id, auth.uid())
      AND c.deletion_grace_started_at IS NOT NULL
      AND c.closed_at IS NULL
  )
  AND NOT COALESCE(public.is_admin_user(), false)
  AND COALESCE((auth.jwt() ->> 'role'), '') <> 'service_role';
$$;

-- Faster check for current auth user
CREATE OR REPLACE FUNCTION public.current_user_blocked_by_community_closure()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.is_member_of_closure_community(auth.uid());
$$;

-- RPC for mobile app to check blocking status on login
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
      'contact_email', 'supp.cluvo@gmail.com'
    );
  END IF;
  
  RETURN jsonb_build_object('blocked', false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_my_community_closure_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_my_community_closure_status() TO anon;

-- RLS policies to block members of communities in closure grace
-- Be surgical and always exempt admins/service role

-- communities: block non-admin members from viewing communities in closure grace
DROP POLICY IF EXISTS "block_closure_communities_select" ON public.communities;
CREATE POLICY "block_closure_communities_select" ON public.communities
FOR SELECT
USING (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    WHEN deletion_grace_started_at IS NOT NULL AND closed_at IS NULL THEN (
      NOT EXISTS (
        SELECT 1 FROM public.community_members cm
        WHERE cm.community_id = communities.id
          AND cm.user_id = auth.uid()
      )
    )
    ELSE true
  END
);

-- events: block non-admin members from accessing events of communities in closure grace
DROP POLICY IF EXISTS "block_closure_events_select" ON public.events;
CREATE POLICY "block_closure_events_select" ON public.events
FOR SELECT
USING (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.communities c
      WHERE c.id = events.community_id
        AND c.deletion_grace_started_at IS NOT NULL
        AND c.closed_at IS NULL
    ) THEN (
      NOT EXISTS (
        SELECT 1 FROM public.community_members cm
        WHERE cm.community_id = events.community_id
          AND cm.user_id = auth.uid()
      )
    )
    ELSE true
  END
);

-- community_members: block non-admin members from viewing membership of communities in closure grace
DROP POLICY IF EXISTS "block_closure_community_members_select" ON public.community_members;
CREATE POLICY "block_closure_community_members_select" ON public.community_members
FOR SELECT
USING (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.communities c
      WHERE c.id = community_members.community_id
        AND c.deletion_grace_started_at IS NOT NULL
        AND c.closed_at IS NULL
    ) THEN (
      community_members.user_id <> auth.uid()
      AND NOT EXISTS (
        SELECT 1 FROM public.community_members cm2
        WHERE cm2.community_id = community_members.community_id
          AND cm2.user_id = auth.uid()
      )
    )
    ELSE true
  END
);

-- registrations: block non-admin members from accessing registrations for events in closure grace communities
DROP POLICY IF EXISTS "block_closure_registrations_select" ON public.registrations;
CREATE POLICY "block_closure_registrations_select" ON public.registrations
FOR SELECT
USING (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.events ev
      JOIN public.communities c ON c.id = ev.community_id
      WHERE ev.id = registrations.event_id
        AND c.deletion_grace_started_at IS NOT NULL
        AND c.closed_at IS NULL
    ) THEN (
      registrations.user_id <> auth.uid()
      AND NOT EXISTS (
        SELECT 1 FROM public.events ev
        JOIN public.community_members cm ON cm.community_id = ev.community_id
        WHERE ev.id = registrations.event_id
          AND cm.user_id = auth.uid()
      )
    )
    ELSE true
  END
);

-- join_requests: block access for members of communities in closure grace (non-admin)
DROP POLICY IF EXISTS "block_closure_join_requests" ON public.join_requests;
CREATE POLICY "block_closure_join_requests" ON public.join_requests
FOR ALL
USING (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.communities c
      WHERE c.id = join_requests.community_id
        AND c.deletion_grace_started_at IS NOT NULL
        AND c.closed_at IS NULL
    ) THEN (
      join_requests.user_id <> auth.uid()
      AND NOT EXISTS (
        SELECT 1 FROM public.community_members cm
        WHERE cm.community_id = join_requests.community_id
          AND cm.user_id = auth.uid()
      )
    )
    ELSE true
  END
)
WITH CHECK (
  CASE
    WHEN COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN true
    WHEN COALESCE(public.is_admin_user(), false) THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.communities c
      WHERE c.id = join_requests.community_id
        AND c.deletion_grace_started_at IS NOT NULL
        AND c.closed_at IS NULL
    ) THEN false
    ELSE true
  END
);

