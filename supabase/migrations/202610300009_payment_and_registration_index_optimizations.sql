-- ============================================================================
-- CLUVO — Payment & Webhook Index Optimization (Milestone A - Task 1)
--
-- 1. idx_payments_order_status:
--    Compound index on (razorpay_order_id, status) WHERE razorpay_order_id IS NOT NULL.
--    Allows verify-payment-webhook to query (id, status) via Index-Only Scan.
--
-- 2. idx_payments_pending_reconcile:
--    Partial index on (created_at) WHERE status = 'pending' AND razorpay_order_id IS NOT NULL AND deleted_at IS NULL.
--    Matches the exact query predicates used by the high-frequency 2-minute reconcile-pending cron.
--
-- Note: Standard transactional index creation is used because supabase db push executes
-- within a multi-statement transaction block (concurrent index builds are unsupported).
-- Note: registrations(event_id, status) is already indexed by idx_registrations_by_event.
-- ============================================================================

-- Compound index for webhook order lookups (Index-Only Scan)
CREATE INDEX IF NOT EXISTS idx_payments_order_status
  ON public.payments (razorpay_order_id, status)
  WHERE razorpay_order_id IS NOT NULL;

-- High-performance partial index for 2-minute reconcile-pending sweep
CREATE INDEX IF NOT EXISTS idx_payments_pending_reconcile
  ON public.payments (created_at)
  WHERE status = 'pending' AND razorpay_order_id IS NOT NULL AND deleted_at IS NULL;
