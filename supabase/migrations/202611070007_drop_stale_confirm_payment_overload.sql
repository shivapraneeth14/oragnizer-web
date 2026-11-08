-- ============================================================================
-- CLUVO — Drop the stale single-argument confirm_payment overload
--
-- 202610310001 added `confirm_payment(uuid)` as a standalone function instead
-- of replacing the canonical 4-argument definition introduced by
-- 202611010001. Because the canonical function has defaults for every extra
-- argument, BOTH signatures are valid targets for a one-argument call, so a
-- webhook or client that sends only `p_payment_id` can hit the stale copy.
-- That copy:
--   * never writes the immutable payment_sales row,
--   * never rotates the QR credential,
--   * does not use the sale-insert wallet idempotency gate,
--   * still inserts into notifications(message), a column that does not exist,
--     so it errors out after the payment row has already been updated.
--
-- Keep only the canonical `confirm_payment(uuid, integer, text, text)`.
-- ============================================================================

DROP FUNCTION IF EXISTS public.confirm_payment(uuid);

REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment(uuid, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payment(uuid, integer, text, text)
  TO service_role;
