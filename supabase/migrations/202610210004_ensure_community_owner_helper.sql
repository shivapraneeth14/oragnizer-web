-- Ensure helper exists for community ownership checks.
--
-- Keep the parameter name `community_id`: the deployed function already uses
-- it, and CREATE OR REPLACE cannot rename an input parameter (SQLSTATE 42P13).
-- The only hardening here is the empty search_path.
CREATE OR REPLACE FUNCTION public.is_community_owner(community_id UUID)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.communities c
    WHERE c.id = community_id
      AND c.owner_id = auth.uid()
  );
$$;
