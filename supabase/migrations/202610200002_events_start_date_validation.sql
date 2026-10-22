-- ============================================================================
-- CLUVO — Enforce "start date in the future" at the database level
--
-- Problem
--   The future-start rule lived only in the organizer-web frontend, so it was
--   bypassable and the form's native `min` attribute blocked legitimate edits
--   of already-started events (fixing a wrong title, etc.).
--
-- Rule (enforced for every writer — client, edge function, console):
--   * INSERT  : start_date must be in the future.
--   * UPDATE  : start_date may be in the past ONLY when it is unchanged, so
--               editing a started event always works; moving a date into the
--               past (new start_date is distinct from old) is rejected.
--   * Status-only / soft-delete updates (cancel-event, admin-delete-community)
--     never touch start_date, so they are unaffected.
--
-- The raised message matches the existing frontend string and surfaces in the
-- organizer error toast via PostgREST -> error.message.
-- ============================================================================

create or replace function public.validate_event_start_date()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.start_date <= now() then
      raise exception 'Start date cannot be in the past';
    end if;
  elsif new.start_date is distinct from old.start_date then
    if new.start_date <= now() then
      raise exception 'Start date cannot be in the past';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_events_validate_start_date
  before insert or update on public.events
  for each row
  execute function public.validate_event_start_date();
