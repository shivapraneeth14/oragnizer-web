-- ============================================================================
-- CLUVO — Distance-ordered events RPC
-- The mobile app used to fetch a date-ordered slice of events (100 rows for
-- All Events, an unordered 50 for "Popular near you") and sort it client-side
-- by haversine distance, so the truly nearest events could be missed. This
-- function computes the same haversine distance in SQL and returns every
-- matching event already ordered nearest-first, each with its distance_km and
-- community name, so the client only has to apply display tie-breakers.
-- SECURITY INVOKER: Row Level Security of the calling user still applies, so
-- only events the caller may read are returned (events_public_read +
-- communities_public_read already exclude deleted, unpublished and hidden).
-- ============================================================================

create or replace function public.events_with_distance(
  user_lat double precision default null,
  user_lng double precision default null,
  free_only boolean default false,
  paid_only boolean default false,
  category_filter text default null,
  date_from timestamptz default null,
  date_to timestamptz default null,
  max_rows integer default 1000
)
returns table (
  id uuid,
  community_id uuid,
  title text,
  description text,
  image_url text,
  video_url text,
  category text,
  start_date timestamptz,
  end_date timestamptz,
  location text,
  latitude numeric,
  longitude numeric,
  capacity integer,
  price integer,
  booked_count integer,
  status text,
  created_by uuid,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz,
  community_name text,
  distance_km double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    e.id,
    e.community_id,
    e.title,
    e.description,
    e.image_url,
    e.video_url,
    e.category,
    e.start_date,
    e.end_date,
    e.location,
    e.latitude,
    e.longitude,
    e.capacity,
    e.price,
    e.booked_count,
    e.status,
    e.created_by,
    e.created_at,
    e.updated_at,
    e.deleted_at,
    c.name as community_name,
    case
      when user_lat is null
        or user_lng is null
        or e.latitude is null
        or e.longitude is null
      then null
      else 6371.0 * 2 * atan2(
        sqrt(
          power(sin(radians(e.latitude::double precision - user_lat) / 2), 2)
          + cos(radians(user_lat))
            * cos(radians(e.latitude::double precision))
            * power(sin(radians(e.longitude::double precision - user_lng) / 2), 2)
        ),
        sqrt(1 - (
          power(sin(radians(e.latitude::double precision - user_lat) / 2), 2)
          + cos(radians(user_lat))
            * cos(radians(e.latitude::double precision))
            * power(sin(radians(e.longitude::double precision - user_lng) / 2), 2)
        ))
      )
    end as distance_km
  from public.events e
  join public.communities c on c.id = e.community_id
  where e.deleted_at is null
    and c.is_hidden = false
    and e.status = 'published'
    and (e.start_date >= now() or e.end_date is null or e.end_date >= now())
    and (free_only = false or e.price = 0)
    and (paid_only = false or e.price > 0)
    and (category_filter is null or e.category = category_filter)
    and (date_from is null or e.start_date >= date_from)
    and (date_to is null or e.start_date < date_to)
  order by distance_km asc nulls last, e.start_date asc
  limit max_rows;
$$;

revoke all on function public.events_with_distance(
  double precision, double precision, boolean, boolean, text, timestamptz, timestamptz, integer
) from public;
grant execute on function public.events_with_distance(
  double precision, double precision, boolean, boolean, text, timestamptz, timestamptz, integer
) to anon, authenticated;
