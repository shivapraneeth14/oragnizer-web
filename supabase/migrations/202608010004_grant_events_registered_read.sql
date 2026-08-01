-- The policy on events evaluates is_registered_for_event for every reader,
-- including logged-out (anon) users reading public events. Grant execution to
-- anon as well; auth.uid() is null for anon, so it simply returns false.
GRANT EXECUTE ON FUNCTION public.is_registered_for_event(uuid) TO anon;
