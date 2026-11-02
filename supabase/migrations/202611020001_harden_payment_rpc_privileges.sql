-- ============================================================================
-- CLUVO — Harden payment RPC privileges (Stage 6 security remediation)
--
-- Critical finding: the payment RPCs added by 202611010001/002/015/016 were
-- hardened only with `REVOKE ... FROM PUBLIC`, which does NOT remove the
-- default EXECUTE grants to `anon` / `authenticated`. This left the
-- payment-confirmation RPCs callable by any logged-in user (and even
-- anonymous), enabling a payment-confirmation bypass: a customer could mark
-- their own payment 'success' with a fabricated razorpay_payment_id without
-- ever paying Razorpay.
--
-- This migration revokes non-service access from the affected RPCs. The Edge
-- Functions call them via the service_role key, and the SECURITY DEFINER
-- dispatcher (admin_resolve_refund_task) calls its callees as the function
-- owner (postgres), so the normal flows are unaffected.
-- ============================================================================

-- 1. Payment confirmation (CRITICAL: payment bypass)
REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment(UUID, INTEGER, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payment(UUID, INTEGER, TEXT, TEXT)
  TO service_role;

-- 2. Webhook confirmation (CRITICAL: webhook signature bypass)
REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment_from_webhook(UUID, TEXT, TEXT, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payment_from_webhook(UUID, TEXT, TEXT, INTEGER, TEXT)
  TO service_role;

-- 3. Capacity hold / release (MEDIUM: hold manipulation)
REVOKE ALL PRIVILEGES ON FUNCTION public.reserve_ticket_capacity(UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ticket_capacity(UUID, UUID, INTEGER)
  TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.release_ticket_capacity(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_ticket_capacity(UUID)
  TO service_role;

-- 4. Admin refund adoption / manual settlement (HIGH: IDOR via p_admin_id)
REVOKE ALL PRIVILEGES ON FUNCTION public.admin_adopt_provider_refund(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adopt_provider_refund(UUID, UUID, TEXT, TEXT)
  TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_manual_settlement(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_manual_settlement(UUID, UUID, JSONB)
  TO service_role;
