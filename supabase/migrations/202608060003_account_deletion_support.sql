-- Account deletion support (Play Store data-deletion requirement).
--
-- When a user deletes their account, the auth user row is deleted via
-- supabase.auth.admin.deleteUser(), which cascades to profiles (FK
-- profiles_id_fkey ON DELETE CASCADE) and everything that cascades off
-- profiles. These conversions make the remaining references either:
--   * SET NULL  -> the record (financial/event/audit trail) is RETAINED for
--                  legal/financial retention, but its link to the deleted
--                  identity is severed (anonymized).
-- Rows that are pure user content (notifications, reviews, reports) are
-- deleted by the delete-account edge function before the auth row goes.
-- Communities.owner_id is intentionally left RESTRICT-style: organizers
-- holding live communities (and their wallet balances) are blocked from
-- deleting until they transfer/close them.

-- registrations: keep the booking + linked payment trail, sever the user link.
alter table registrations
  alter column user_id drop not null;
alter table registrations
  drop constraint if exists registrations_user_id_fkey;
alter table registrations
  add constraint registrations_user_id_fkey
    foreign key (user_id) references profiles(id) on delete set null;

-- events: keep the event, sever the creator link.
alter table events
  alter column created_by drop not null;
alter table events
  drop constraint if exists events_created_by_fkey;
alter table events
  add constraint events_created_by_fkey
    foreign key (created_by) references profiles(id) on delete set null;

-- event_restricted_users: keep the restriction, sever the creator link.
alter table event_restricted_users
  alter column created_by drop not null;
alter table event_restricted_users
  drop constraint if exists event_restricted_users_created_by_fkey;
alter table event_restricted_users
  add constraint event_restricted_users_created_by_fkey
    foreign key (created_by) references profiles(id) on delete set null;

-- audit_log: keep the trail (security/ops), sever the actor link. The
-- delete-account function additionally strips details/target_id PII.
-- NOTE: on PROD the inline REFERENCES in 202607260002 never materialized
-- (CREATE TABLE IF NOT EXISTS + pre-existing table), so the constraint may
-- be absent — hence DROP CONSTRAINT IF EXISTS.
alter table audit_log
  alter column actor_id drop not null;
alter table audit_log
  drop constraint if exists audit_log_actor_id_fkey;
alter table audit_log
  add constraint audit_log_actor_id_fkey
    foreign key (actor_id) references profiles(id) on delete set null;
