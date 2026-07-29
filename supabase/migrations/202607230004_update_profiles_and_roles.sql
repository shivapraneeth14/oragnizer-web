-- ============================================================================
-- CLUVO — Update profiles + roles architecture
-- Drop profiles.role, add first_name/last_name/username, uppercase roles
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Update profiles — drop role, add new fields
-- ---------------------------------------------------------------------------
alter table profiles drop column role;

alter table profiles add column first_name text;
alter table profiles add column last_name text;
alter table profiles add column username text unique;

create unique index idx_profiles_username on profiles (username) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. Update community_members — uppercase roles + add OWNER
-- ---------------------------------------------------------------------------
alter table community_members 
  alter column role set default 'MEMBER',
  drop constraint if exists community_members_role_check,
  add constraint community_members_role_check 
    check (role in ('MEMBER', 'MODERATOR', 'ORGANIZER', 'OWNER'));

-- ---------------------------------------------------------------------------
-- 3. Update handle_new_user trigger — no role, use new fields
-- ---------------------------------------------------------------------------
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, first_name, last_name, username, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'last_name',
    new.raw_user_meta_data->>'username',
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer;
