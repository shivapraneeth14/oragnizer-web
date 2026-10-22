-- Ensure helper exists for community ownership checks
CREATE OR REPLACE FUNCTION public.is_community_owner(p_community_id UUID)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.communities c
    WHERE c.id = p_community_id
      AND c.owner_id = auth.uid()
  );
$$;
