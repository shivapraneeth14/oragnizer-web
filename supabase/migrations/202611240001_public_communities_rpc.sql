-- ============================================================================
-- CLUVO — Public community directory read RPC
--
-- Why
--   chigzo-web's public directory filters communities on
--   deletion_grace_started_at, but that column is intentionally not granted to
--   anon (202610220010 + 202610280002). PostgREST therefore rejects the query
--   and the directory renders empty for signed-out visitors.
--
-- What
--   A read-only, SECURITY DEFINER function that applies the public-directory
--   filters on the database side and exposes only the safe community columns.
--   This keeps the deletion timestamp private while giving anon the same list
--   the mobile app intends to show.
--
-- Scope
--   Additive only. No table, column, policy, or existing data is changed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_public_communities(
  p_category text DEFAULT NULL,
  p_limit integer DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  name text,
  description text,
  location text,
  banner_url text,
  community_avatar_url text,
  owner_id uuid,
  visibility text,
  verification_status text,
  is_hidden boolean,
  member_count integer,
  event_count integer,
  category text,
  country text,
  state text,
  city text,
  tags text[],
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    c.id,
    c.name,
    c.description,
    c.location,
    c.banner_url,
    c.community_avatar_url,
    c.owner_id,
    c.visibility,
    c.verification_status,
    c.is_hidden,
    c.member_count,
    c.event_count,
    c.category,
    c.country,
    c.state,
    c.city,
    c.tags,
    c.created_at,
    c.updated_at,
    c.deleted_at
  FROM public.communities AS c
  WHERE c.deleted_at IS NULL
    AND c.deletion_grace_started_at IS NULL
    AND c.is_hidden = false
    AND c.visibility = 'public'
    AND (
      NULLIF(btrim(p_category), '') IS NULL
      OR c.category = btrim(p_category)
    )
  ORDER BY c.member_count DESC, c.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 60), 1), 100);
$$;

COMMENT ON FUNCTION public.get_public_communities(text, integer) IS
  'Safe public community-directory list for anon/authenticated clients. Applies hidden, deleted, deletion-grace, and visibility filters.';

REVOKE ALL ON FUNCTION public.get_public_communities(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_public_communities(text, integer) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_public_community_categories()
RETURNS TABLE (category text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT btrim(c.category) AS category
  FROM public.communities AS c
  WHERE c.deleted_at IS NULL
    AND c.deletion_grace_started_at IS NULL
    AND c.is_hidden = false
    AND c.visibility = 'public'
    AND c.category IS NOT NULL
    AND btrim(c.category) <> ''
  ORDER BY 1;
$$;

COMMENT ON FUNCTION public.get_public_community_categories() IS
  'Distinct public community categories using the same visibility filters as get_public_communities.';

REVOKE ALL ON FUNCTION public.get_public_community_categories() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_public_community_categories() TO anon, authenticated, service_role;
