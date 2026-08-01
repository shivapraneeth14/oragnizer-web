-- Fix FK references: point to profiles(id) instead of auth.users(id)
-- so PostgREST can resolve the profiles:user_id(...) join.

ALTER TABLE event_messages
  DROP CONSTRAINT event_messages_user_id_fkey,
  ADD CONSTRAINT event_messages_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE event_restricted_users
  DROP CONSTRAINT event_restricted_users_user_id_fkey,
  DROP CONSTRAINT event_restricted_users_created_by_fkey,
  ADD CONSTRAINT event_restricted_users_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE,
  ADD CONSTRAINT event_restricted_users_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES profiles(id);
