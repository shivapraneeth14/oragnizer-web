-- ============================================================================
-- CLUVO — Retain content reports when a reporter deletes their account
--
-- Problem
--   content_reports.reporter_id is NOT NULL with ON DELETE CASCADE
--   (202610110004:18). Deleting an account therefore destroys every report it
--   filed, even though reports are moderation records the audit says we keep.
--
-- Fix
--   Make reporter_id nullable and change the FK to ON DELETE SET NULL. The
--   purge function scrubs the reporter's free text BEFORE the auth user is
--   deleted, so the retained row no longer identifies the reporter. Admins can
--   still read it via content_reports_select_own_or_admin; regular users cannot
--   match a NULL reporter_id.
-- ============================================================================

ALTER TABLE public.content_reports ALTER COLUMN reporter_id DROP NOT NULL;

ALTER TABLE public.content_reports DROP CONSTRAINT IF EXISTS content_reports_reporter_id_fkey;
ALTER TABLE public.content_reports
  ADD CONSTRAINT content_reports_reporter_id_fkey
  FOREIGN KEY (reporter_id) REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.content_reports.reporter_id IS
  'Reporter auth user. NULL after the reporter deletes their account; the '
  'report body is retained for moderation and free text is scrubbed first.';
