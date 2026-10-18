-- Consent versioning: one row per (user, consent_version).
--
-- consent_log already stores immutable per-version history (the edge
-- functions write the server-side CONSENT_VERSION constant; clients can
-- never write this table). This migration adds the uniqueness guarantee so
-- the record-consent POST can safely insert a NEW row when a user re-accepts
-- an updated policy version, without risking duplicate rows for the same
-- version under concurrent requests.
--
-- Existing rows are preserved. If any duplicate (user_id, consent_version)
-- pairs exist in an environment, keep the EARLIEST accepted_at row.

create unique index if not exists consent_log_user_version_key
  on public.consent_log (user_id, consent_version);
