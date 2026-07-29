-- Allow authenticated users to follow (insert into) a community
drop policy if exists community_members_self_insert on community_members;
create policy community_members_self_insert on community_members
  for insert with check (user_id = auth.uid());

-- Allow users to unfollow (delete) their own membership
drop policy if exists community_members_self_delete on community_members;
create policy community_members_self_delete on community_members
  for delete using (user_id = auth.uid());

-- Auto-update member_count on insert/delete
create or replace function update_community_member_count()
returns trigger
language plpgsql
security definer
as $$
begin
  if tg_op = 'INSERT' then
    update communities set member_count = member_count + 1 where id = new.community_id;
    return new;
  elsif tg_op = 'DELETE' then
    update communities set member_count = member_count - 1 where id = old.community_id;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_community_members_count on community_members;
create trigger trg_community_members_count
  after insert or delete on community_members
  for each row execute function update_community_member_count();
