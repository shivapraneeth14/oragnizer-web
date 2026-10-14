-- ============================================================================
-- CLUVO — User-generated-content safety: Report + Block (Phase 4b, M3)
--
-- Google Play's UGC policy requires apps with user-generated content to give
-- users a way to report objectionable content and block abusive users, and to
-- act on reports. Discussion messages (event_messages) are the only UGC today.
--
--   content_reports : one row per report. Users insert/read their own; admins
--                     read all and update status.
--   user_blocks     : a user's personal block list. Fully self-managed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- content_reports
-- ---------------------------------------------------------------------------
CREATE TABLE public.content_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('event_message', 'community', 'event', 'user')),
  target_id UUID NOT NULL,
  -- Author of the reported content, when known (helps moderation + alerts).
  target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 100),
  details TEXT CHECK (details IS NULL OR char_length(details) <= 2000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed', 'actioned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_content_reports_status ON public.content_reports (status, created_at DESC);
-- One report per user per item — prevents a single user spamming duplicates.
CREATE UNIQUE INDEX uq_content_reports_reporter_target
  ON public.content_reports (reporter_id, target_type, target_id);

ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY content_reports_insert_own ON public.content_reports
  FOR INSERT TO authenticated
  WITH CHECK (reporter_id = auth.uid());

CREATE POLICY content_reports_select_own_or_admin ON public.content_reports
  FOR SELECT TO authenticated
  USING (reporter_id = auth.uid() OR public.is_admin_user());

CREATE POLICY content_reports_update_admin ON public.content_reports
  FOR UPDATE TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

GRANT SELECT, INSERT, UPDATE ON public.content_reports TO authenticated;
GRANT ALL ON public.content_reports TO service_role;

-- resolved timestamp bookkeeping mirrors admin_alerts.
CREATE OR REPLACE FUNCTION public.set_content_report_reviewed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status <> 'open' AND NEW.reviewed_at IS NULL THEN
    NEW.reviewed_at := now();
    NEW.reviewed_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_content_reports_reviewed_at
  BEFORE UPDATE ON public.content_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.set_content_report_reviewed_at();

-- ---------------------------------------------------------------------------
-- user_blocks
-- ---------------------------------------------------------------------------
CREATE TABLE public.user_blocks (
  blocker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_blocks_select_own ON public.user_blocks
  FOR SELECT TO authenticated
  USING (blocker_id = auth.uid());

CREATE POLICY user_blocks_insert_own ON public.user_blocks
  FOR INSERT TO authenticated
  WITH CHECK (blocker_id = auth.uid());

CREATE POLICY user_blocks_delete_own ON public.user_blocks
  FOR DELETE TO authenticated
  USING (blocker_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON public.user_blocks TO authenticated;
GRANT ALL ON public.user_blocks TO service_role;
