-- ============================================================================
-- CLUVO — Harden exposed money/queue RPCs (Stage 7 security audit)
--
-- CONFIRMED (reproduced against live local DB as the anon role):
--   credit_wallet, debit_wallet, cancel_event_and_enqueue_refunds,
--   claim_refund_tasks, and update_cancellation_job_progress remained
--   callable by PUBLIC / anon / authenticated.
--
--   * credit_wallet / debit_wallet  -> CRITICAL: arbitrary wallet balance
--       forgery (credit) and drain (debit) by anonymous callers.
--   * cancel_event_and_enqueue_refunds -> CRITICAL IDOR: authorized off the
--       caller-supplied p_caller_id instead of auth.uid(); the owner_id is
--       publicly readable, so an anon caller could cancel ANY event.
--   * claim_refund_tasks            -> HIGH: anon can lease refund tasks and
--       stall the refund queue.
--   * update_cancellation_job_progress -> HIGH: anon can corrupt the
--       cancellation state machine / force an event to 'cancelled'.
--
-- ROOT CAUSE: (a) CREATE OR REPLACE with a new argument count created NEW
-- overloads carrying the default PUBLIC EXECUTE grant, then the old
-- (previously revoked) overloads were dropped; (b) REVOKE ... FROM PUBLIC
-- does NOT remove the explicit anon/authenticated grants that Supabase applies
-- to public-schema functions by default.
--
-- ALL legitimate callers use the service_role key (edge functions) or are
-- internal SECURITY DEFINER calls that run as the function owner, so locking
-- these to service_role does not affect the normal flows.
-- ============================================================================

-- 1. Wallet money movement (CRITICAL: balance forgery / drain)
REVOKE ALL PRIVILEGES ON FUNCTION public.credit_wallet(uuid, integer, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet(uuid, integer, uuid, uuid)
  TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.debit_wallet(uuid, integer, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_wallet(uuid, integer, text, uuid, uuid)
  TO service_role;

-- 2. Refund queue worker lease (HIGH: refund queue DoS)
REVOKE ALL PRIVILEGES ON FUNCTION public.claim_refund_tasks(integer, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_refund_tasks(integer, text, integer)
  TO service_role;

-- 3. Cancellation progress mutation (HIGH: state-machine corruption)
REVOKE ALL PRIVILEGES ON FUNCTION public.update_cancellation_job_progress(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_cancellation_job_progress(uuid)
  TO service_role;

-- 4. Event cancellation enqueue (CRITICAL IDOR): lock to service_role.
--    The only legitimate caller is the cancel-event edge function, which
--    authenticates the user via auth.getUser() and passes the authenticated
--    user.id as p_caller_id; the ownership check inside the RPC then uses that
--    real id. Removing anon/authenticated access closes the IDOR because no
--    caller can supply an arbitrary p_caller_id anymore.
REVOKE ALL PRIVILEGES ON FUNCTION public.cancel_event_and_enqueue_refunds(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_event_and_enqueue_refunds(uuid, uuid)
  TO service_role;
