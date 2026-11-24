-- ============================================================================
-- CLUVO — Public community detail read RPC
--
-- Why
--   chigzo-web's /communities/[id] page selected COMMUNITY_PROFILE_SELECT,
--   which includes contact_email/contact_phone. Those columns are intentionally
--   not granted to anon, so PostgREST rejected the query and the page rendered
--   notFound() for signed-out visitors.
--
-- What
--   A read-only, SECURITY DEFINER function that returns the public profile
--   fields the page needs while applying the same public-visibility filters as
--   the directory. Private contact and financial columns are never returned.
--
-- Scope
--   Additive only. No table, column, policy, or existing data is changed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_public_community_by_id(p_community_id uuid)
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
  rules text,
  instagram_url text,
  facebook_url text,
  twitter_url text,
  linkedin_url text,
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
    c.rules,
    c.instagram_url,
    c.facebook_url,
    c.twitter_url,
    c.linkedin_url,
    c.created_at,
    c.updated_at,
    c.deleted_at
  FROM public.communities AS c
  WHERE c.id = p_community_id
    AND c.deleted_at IS NULL
    AND c.deletion_grace_started_at IS NULL
    AND c.is_hidden = false
    AND c.visibility = 'public';
$$;

COMMENT ON FUNCTION public.get_public_community_by_id(uuid) IS
  'Safe public community detail for anon/authenticated clients. Excludes contact and financial columns while applying deleted, hidden, deletion-grace, and visibility filters.';

REVOKE ALL ON FUNCTION public.get_public_community_by_id(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_public_community_by_id(uuid) TO anon, authenticated, service_role;
