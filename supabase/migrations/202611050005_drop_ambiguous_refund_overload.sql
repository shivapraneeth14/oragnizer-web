-- 202611050001 introduced the 7-argument complete_payment_refund (with
-- p_debit_wallet) but left the old 6-argument overload in place. Because the
-- 7th argument has a default, every 6-argument call became ambiguous
-- (Postgres error 42725: function is not unique). Keep only the canonical
-- 7-argument definition.
DROP FUNCTION IF EXISTS public.complete_payment_refund(
  uuid, boolean, text, text, integer, text
);

REVOKE ALL PRIVILEGES ON FUNCTION public.complete_payment_refund(UUID, BOOLEAN, TEXT, TEXT, INTEGER, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_payment_refund(UUID, BOOLEAN, TEXT, TEXT, INTEGER, TEXT, BOOLEAN) TO service_role;
