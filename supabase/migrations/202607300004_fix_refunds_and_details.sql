-- ============================================================================
-- CLUVO — REFUND TRACKING & DETAILS
--
--     1. razorpay_refund_id + refunded_amount on payments (reconciliation)
-- ============================================================================

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS razorpay_refund_id TEXT,
  ADD COLUMN IF NOT EXISTS refunded_amount INTEGER;

COMMENT ON COLUMN payments.razorpay_refund_id IS 'Razorpay refund ID from the refund API call';
COMMENT ON COLUMN payments.refunded_amount IS 'Actual amount refunded in paise (may differ from amount for partial refunds)';
