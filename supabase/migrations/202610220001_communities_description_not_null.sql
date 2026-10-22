-- Make community description mandatory going forward.
-- Backfill legacy rows that have a NULL or blank description with a
-- placeholder sentence (organizers can edit it later via the
-- update-community-profile edge function), then enforce at the database
-- level so every future write (app, function, direct) must supply one.

update communities
  set description = 'This community has not added a description yet.'
  where description is null or char_length(btrim(description)) = 0;

alter table communities
  alter column description set not null;
