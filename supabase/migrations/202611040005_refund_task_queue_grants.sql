-- -------------------------------------------------------
-- F-5: refund_task_queue and event_cancellation_jobs table grants
--   Required for authenticated admins to read cancellation/refund data.
--   RLS policies alone are not sufficient; table SELECT grant is also needed.
-- -------------------------------------------------------
GRANT SELECT ON public.refund_task_queue TO authenticated;
GRANT SELECT ON public.event_cancellation_jobs TO authenticated;
