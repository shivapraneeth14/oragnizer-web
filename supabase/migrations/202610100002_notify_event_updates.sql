-- Notify confirmed registrants when a live event's date/time or location
-- changes. Registered users are the ones affected by a reschedule; the event
-- creator is excluded (they made the edit). Only fires while the event stays
-- published AND one of the meaningful fields actually changed, so cosmetic
-- edits (description, photo, title) stay silent.

create or replace function notify_event_updated()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_msg text := 'The event "' || new.title || '" has been updated:';
begin
  if old.start_date is distinct from new.start_date
     or old.end_date is distinct from new.end_date then
    v_msg := v_msg || ' · new date/time '
             || to_char(new.start_date at time zone 'UTC', 'YYYY-MM-DD HH24:MI')
             || ' UTC';
  end if;
  if old.location is distinct from new.location then
    v_msg := v_msg || ' · location ' || coalesce(new.location, 'removed');
  end if;
  insert into public.notifications (user_id, type, title, body, payload)
  select r.user_id, 'event_updated', 'Event updated', v_msg,
         jsonb_build_object('type', 'event', 'id', new.id)
  from public.registrations r
  where r.event_id = new.id
    and r.status = 'confirmed'
    and r.deleted_at is null
    and r.user_id is distinct from new.created_by;
  return new;
end;
$$;

create trigger trg_notify_event_updated
  after update on public.events
  for each row
  when (new.status = 'published'
        and old.status = 'published'
        and (old.start_date is distinct from new.start_date
          or old.end_date is distinct from new.end_date
          or old.location is distinct from new.location))
  execute function notify_event_updated();