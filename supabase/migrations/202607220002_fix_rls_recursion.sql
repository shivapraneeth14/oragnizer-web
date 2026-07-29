-- ============================================================================
-- CLUVO — Fix RLS infinite recursion from circular policy references
-- ============================================================================

-- Helper: check if user owns a community (bypasses RLS via security definer)
create or replace function public.is_community_owner(community_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.communities c
    where c.id = community_id and c.owner_id = auth.uid()
  );
$$;

-- Helper: check if user is a member of a community (bypasses RLS via security definer)
create or replace function public.is_community_member(community_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.community_members cm
    where cm.community_id = community_id and cm.user_id = auth.uid()
  );
$$;

-- Fix communities policies — use helper functions instead of direct subqueries
drop policy if exists "communities_team_read" on communities;
create policy "communities_team_read" on communities
  for select using (
    is_community_owner(id)
    or is_community_member(id)
  );

-- Fix community_members policies — use helper functions
drop policy if exists "community_members_team_read" on community_members;
create policy "community_members_team_read" on community_members
  for select using (
    is_community_owner(community_id)
    or is_community_member(community_id)
  );

-- Fix events policies — use helper functions
drop policy if exists "events_team_read" on events;
create policy "events_team_read" on events
  for select using (
    is_community_owner(community_id)
    or is_community_member(community_id)
  );

-- Fix registrations policies — use helper functions
drop policy if exists "registrations_team_read" on registrations;
create policy "registrations_team_read" on registrations
  for select using (
    is_community_owner(
      (select community_id from events where id = event_id)
    )
    or is_community_member(
      (select community_id from events where id = event_id)
    )
  );

-- Fix payments policies — use helper functions
drop policy if exists "payments_team_read" on payments;
create policy "payments_team_read" on payments
  for select using (
    is_community_owner(
      (select e.community_id from registrations r join events e on e.id = r.event_id where r.id = registration_id)
    )
    or is_community_member(
      (select e.community_id from registrations r join events e on e.id = r.event_id where r.id = registration_id)
    )
  );

-- Fix join_requests policies — use helper functions
drop policy if exists "join_requests_team_read" on join_requests;
create policy "join_requests_team_read" on join_requests
  for select using (
    is_community_owner(community_id)
  );
