-- Notify community members only when an event actually goes live.
-- The old trg_notify_new_event fired on ANY insert, so a hidden draft event
-- (RLS only exposes status='published') notified members with "New event
-- created" even though it was invisible; and publishing a draft (an UPDATE
-- draft -> published) never notified anyone because the trigger was
-- insert-only.
--
-- Now:
--   * insert where status = 'published'       -> notify members
--   * update INTO published (e.g. draft)      -> notify members
--   * edits while already published           -> NOT notify (handled by
--     notify_event_updated, see 202610100002)

drop trigger if exists trg_notify_new_event on public.events;

create trigger trg_notify_new_event
  after insert on public.events
  for each row
  when (new.status = 'published')
  execute function notify_new_event();

create trigger trg_notify_event_published
  after update on public.events
  for each row
  when (old.status is distinct from 'published' and new.status = 'published')
  execute function notify_new_event();