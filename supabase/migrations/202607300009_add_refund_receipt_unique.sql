-- ============================================================================
-- Add UNIQUE constraint on payments.razorpay_refund_id
-- Prevents duplicate refund records and supports idempotent refund handling
-- ============================================================================

-- Add unique constraint on razorpay_refund_id (NULLs allowed in unique index in Postgres)
DROP INDEX IF EXISTS idx_payments_razorpay_refund_unique;
CREATE UNIQUE INDEX idx_payments_razorpay_refund_unique
  ON payments (razorpay_refund_id)
  WHERE razorpay_refund_id IS NOT NULL;
