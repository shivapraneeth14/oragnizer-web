-- Make end_date mandatory going forward.
-- Backfill the few legacy rows (verified: 2 on TEST, 1 on PROD) with a
-- default 2-hour duration, then enforce at the database level so every
-- future write (app, function, direct) must supply an end date.

update events
  set end_date = start_date + interval '2 hours'
  where end_date is null;

alter table events
  alter column end_date set not null;
