-- ============================================================================
-- CLUVO — Payment columns (Phase 3.3/3.4, added via ALTER TABLE)
--
-- These columns were added to the payments table during Phase 3.3/3.4 setup
-- to support refund tracking, fee calculation, coupon discounts, and ticket pricing.
-- ============================================================================

-- Add refund_attempt_count column to payments (integer, default 0)
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refund_attempt_count integer NOT NULL DEFAULT 0;

-- Add platform_fee column to payments (integer, default 0)
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS platform_fee integer NOT NULL DEFAULT 0;

-- Add platform_fee_gst column to payments (integer, default 0)
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS platform_fee_gst integer NOT NULL DEFAULT 0;

-- Add coupon_id column to payments (uuid, nullable)
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS coupon_id uuid;

-- Add ticket_price column to payments (integer, default 0)
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS ticket_price integer NOT NULL DEFAULT 0;
