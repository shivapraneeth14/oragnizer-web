-- ============================================================================
-- CHIGZO — Fix RLS admin check in cancellation / refund queue policies
--
-- Both policies used a raw `(SELECT is_admin FROM public.profiles …)`
-- subquery. `profiles.is_admin` SELECT was revoked from `authenticated`
-- (202610120005), so the subquery runs as the caller and raises
-- "permission denied for column is_admin" (or behaves inconsistently) when
-- admin/team reads touch these tables. Replace it with the SECURITY DEFINER
-- helper is_admin_user(), which every other admin gate already uses.
--
-- The owner/team access rules are unchanged.
-- ============================================================================

DROP POLICY IF EXISTS cancellation_jobs_team_read ON public.event_cancellation_jobs;
CREATE POLICY cancellation_jobs_team_read ON public.event_cancellation_jobs
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.events e
    JOIN public.communities c ON c.id = e.community_id
    WHERE e.id = event_cancellation_jobs.event_id
      AND (
        c.owner_id = (SELECT auth.uid())
        OR EXISTS (
          SELECT 1 FROM public.community_members m
          WHERE m.community_id = c.id
            AND m.user_id = (SELECT auth.uid())
            AND m.role IN ('ORGANIZER', 'MODERATOR')
        )
      )
  )
  OR public.is_admin_user()
);

DROP POLICY IF EXISTS refund_task_queue_team_read ON public.refund_task_queue;
CREATE POLICY refund_task_queue_team_read ON public.refund_task_queue
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.events e
    JOIN public.communities c ON c.id = e.community_id
    WHERE e.id = refund_task_queue.event_id
      AND (
        c.owner_id = (SELECT auth.uid())
        OR EXISTS (
          SELECT 1 FROM public.community_members m
          WHERE m.community_id = c.id
            AND m.user_id = (SELECT auth.uid())
            AND m.role IN ('ORGANIZER', 'MODERATOR')
        )
      )
  )
  OR public.is_admin_user()
);
