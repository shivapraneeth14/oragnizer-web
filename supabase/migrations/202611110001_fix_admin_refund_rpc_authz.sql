-- ============================================================================
-- CHIGZO — Security fix (H1): remove `authenticated` EXECUTE on admin refund
-- writers.
--
-- admin_adopt_provider_refund and admin_manual_settlement are SECURITY DEFINER
-- money-mutating functions that authorize on the caller-supplied p_admin_id
-- parameter (they have no auth.uid() check, and cannot — the service-role
-- caller has no auth.uid()). Re-granting them to `authenticated`
-- (202611040003, 202611050008, 202611070008) let any signed-in user call them
-- directly via PostgREST with a guessed/leaked admin UUID, bypassing:
--   1. admin_resolve_refund_task (the dispatcher), which correctly verifies
--      auth.uid() = p_admin_id AND is_admin_user(); and
--   2. the admin-adopt-refund edge function, which verifies the caller is an
--      admin before invoking (and runs with the service_role key).
--
-- These functions must remain callable only by:
--   - service_role (edge functions), and
--   - the SECURITY DEFINER dispatcher (which runs as the function owner, so it
--     can still call them without an `authenticated` grant).
-- ============================================================================

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_adopt_provider_refund(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adopt_provider_refund(UUID, UUID, TEXT, TEXT)
  TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_manual_settlement(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_manual_settlement(UUID, UUID, JSONB)
  TO service_role;
