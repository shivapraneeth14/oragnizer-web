-- ============================================================================
-- CLUVO — Drop stale credit_wallet / debit_wallet overloads
--
-- Migration 202611020003 added p_payment_id by CREATE OR REPLACE with a new
-- argument count, which created an *overload* instead of replacing the original
-- (CREATE OR REPLACE matches on argument types). This left two overloads each,
-- breaking complete_payment_refund's 4-arg debit_wallet call.
-- Drop the old overloads so only the p_payment_id-aware versions remain.
-- ============================================================================

DROP FUNCTION IF EXISTS public.credit_wallet(uuid, integer, uuid);
DROP FUNCTION IF EXISTS public.debit_wallet(uuid, integer, text, uuid);
