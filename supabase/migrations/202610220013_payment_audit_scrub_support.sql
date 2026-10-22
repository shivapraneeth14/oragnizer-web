-- ============================================================================
-- CLUVO — Payment audit scrub support (defect D5)
--
-- payment_audit_log stores raw user UUIDs in details JSONB (from
-- cancel-event and issue-refund) and raw Cashfree responses containing
-- bank details and emails (from withdraw-wallet and create-beneficiary).
-- None of these are scrubbed on account deletion.
--
-- This migration adds:
--   1. A GIN index on details so the deletion scrub can efficiently find
--      rows whose details->>'user_id' or details->>'triggered_by' match a
--      deleted user.
--   2. No destructive changes — scrubbing happens in the purge edge
--      function at deletion time, not retroactively.
-- ============================================================================

-- GIN index on details for JSONB path queries used by the scrub.
CREATE INDEX IF NOT EXISTS idx_payment_audit_log_details
  ON public.payment_audit_log USING gin (details);

-- Supporting index for the common "by payment_id" lookup.
CREATE INDEX IF NOT EXISTS idx_payment_audit_log_payment_id
  ON public.payment_audit_log (payment_id);
