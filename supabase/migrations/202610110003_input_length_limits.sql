-- ============================================================================
-- CLUVO — Input length limits (Phase 1, E8)
--
-- Several user-supplied free-text columns had no upper bound, allowing very
-- large payloads (storage abuse, UI/render blowups, log flooding). Add NOT
-- VALID CHECK constraints so existing rows are left untouched while every
-- new/updated row is bounded.
-- ============================================================================

-- Event discussion messages (client inserts directly via PostgREST/RLS).
ALTER TABLE public.event_messages
  ADD CONSTRAINT event_messages_content_len
  CHECK (char_length(content) BETWEEN 1 AND 2000) NOT VALID;

-- Communities (created/updated via edge functions, which also validate).
ALTER TABLE public.communities
  ADD CONSTRAINT communities_name_len
  CHECK (char_length(name) <= 100) NOT VALID;

ALTER TABLE public.communities
  ADD CONSTRAINT communities_description_len
  CHECK (description IS NULL OR char_length(description) <= 2000) NOT VALID;
