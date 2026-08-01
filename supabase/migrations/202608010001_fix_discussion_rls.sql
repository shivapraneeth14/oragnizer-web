-- Require community membership to post in a discussion.
-- Previously the insert policy never checked membership, so a removed member
-- could keep posting forever. Recreate with an added membership requirement.
drop policy if exists event_messages_insert on event_messages;
create policy event_messages_insert on event_messages for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from events e
      where e.id = event_id and e.discussion_enabled = true and e.deleted_at is null
      and (
        e.discussion_restricted = false
        or exists (
          select 1 from community_members cm
          where cm.community_id = e.community_id and cm.user_id = auth.uid()
          and cm.role in ('OWNER', 'ORGANIZER', 'MODERATOR')
        )
      )
    )
    and exists (
      select 1 from events e
      join community_members cm on cm.community_id = e.community_id
      where e.id = event_id and cm.user_id = auth.uid()
    )
    and not exists (
      select 1 from event_restricted_users ru
      where ru.event_id = event_messages.event_id and ru.user_id = auth.uid()
    )
  );

-- Publish restriction and membership changes so clients can update the
-- discussion UI instantly when a user is restricted or removed.
alter publication supabase_realtime add table event_restricted_users;
alter publication supabase_realtime add table community_members;
