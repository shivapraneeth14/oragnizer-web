alter table events add column if not exists image_url text;

drop policy if exists events_team_insert on events;
create policy events_team_insert on events for insert with check (
  is_community_owner(community_id) or is_community_member(community_id)
);

drop policy if exists events_team_update on events;
create policy events_team_update on events for update using (
  is_community_owner(community_id) or is_community_member(community_id)
);

drop policy if exists events_team_delete on events;
create policy events_team_delete on events for delete using (
  is_community_owner(community_id)
);
