-- ============================================================================
-- CLUVO — Profile columns (Phase 3.3/3.4, added via ALTER TABLE)
--
-- These columns were added to the profiles table during Phase 3.3/3.4 setup
-- to support admin gates, contact information, and financial tracking.
-- ============================================================================

-- Add is_admin column to profiles (boolean, default false)
-- Used by admin gates: is_admin_user() function checks this column
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

-- Add email column to profiles (text, nullable)
-- Previously revoked from anonymous role read access in migration 1
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email text;
