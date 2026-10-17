-- ============================================================================
-- CLUVO — Event category
-- Adds a nullable category to events so the mobile Home screen can power
-- "Popular right now", "Explore by category" and mood discovery with real
-- data. Values are captured by the organizer portal from a fixed preset list
-- (the dropdown), not free text.
-- ============================================================================

alter table events add column if not exists category text;

create index if not exists idx_events_category
  on events (category)
  where deleted_at is null;

-- Seed existing events from their community's category so the feature is
-- immediately useful without waiting for organizers to edit every event.
-- Only copy when the community's (free-text) category already matches one of
-- the event presets, so events never hold a value the event dropdown cannot
-- offer; non-matching communities are left null.
update events e
set category = c.category
from communities c
where e.community_id = c.id
  and e.category is null
  and c.category in (
    'Music', 'Technology', 'Comedy', 'Workshops', 'Wellness',
    'Art & Culture', 'Sports & Fitness', 'Food & Drink',
    'Business & Finance', 'Education', 'Social & Community', 'Other'
  );

-- Read-only aggregate used by the mobile Home "Explore by category" section so
-- counts are accurate instead of being inferred from a capped page of events.
-- SECURITY INVOKER: Row Level Security of the calling user still applies, so
-- only events the caller may read are counted.
create or replace function public.event_category_counts()
returns table (category text, event_count bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select e.category, count(*)::bigint
  from public.events e
  join public.communities c on c.id = e.community_id
  where e.deleted_at is null
    and e.status = 'published'
    and e.category is not null
    and btrim(e.category) <> ''
    and c.is_hidden = false
    and (e.start_date >= now() or e.end_date >= now())
  group by e.category
  order by count(*) desc, e.category asc;
$$;

revoke all on function public.event_category_counts() from public;
grant execute on function public.event_category_counts() to anon, authenticated;
