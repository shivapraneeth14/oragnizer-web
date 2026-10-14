-- ============================================================================
-- CLUVO — Privilege & RLS hardening (Phase 1)
--
-- Closes client-reachable escalation / money-movement paths found during the
-- security scan. EVERY one of these RPCs is invoked only by Supabase Edge
-- Functions, which authenticate with the service_role key. No client app
-- (mobile, organizer-web, admin-web) calls any of them via PostgREST, so
-- revoking EXECUTE from anon/authenticated/PUBLIC and re-granting to
-- service_role does not change any legitimate flow.
--
-- Also protects profiles.is_admin from self-escalation, stops anonymous
-- reading of every user's email, stops arbitrary self-appointment to a
-- community team role, and removes client INSERT into the admin audit log.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Money / authority RPCs: service_role only.
--    (confirm_payment alone can confirm a registration and credit the
--     organizer wallet without any payment; credit_wallet/debit_wallet mutate
--     any wallet; initiate_wallet_withdrawal drains one; the rest mutate
--     payment/payout/booking/rate-limit state.)
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.confirm_payment(UUID)                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.credit_wallet(UUID, INTEGER, UUID)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.debit_wallet(UUID, INTEGER, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.initiate_wallet_withdrawal(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_wallet(UUID)                   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_wallet_statement(UUID, UUID)      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.try_process_webhook(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reconcile_payments()                  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cancel_stale_pending()                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_coupon(UUID)                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_coupon(UUID)                  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_event_booked(UUID)          FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.decrement_event_booked(UUID)          FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, INTEGER, INTEGER)        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit_strict(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.confirm_payment(UUID)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_wallet(UUID, INTEGER, UUID)    TO service_role;
GRANT EXECUTE ON FUNCTION public.debit_wallet(UUID, INTEGER, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.initiate_wallet_withdrawal(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_wallet(UUID)                   TO service_role;
GRANT EXECUTE ON FUNCTION public.get_wallet_statement(UUID, UUID)      TO service_role;
GRANT EXECUTE ON FUNCTION public.try_process_webhook(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_payments()                  TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_stale_pending()                TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_coupon(UUID)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.release_coupon(UUID)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_event_booked(UUID)          TO service_role;
GRANT EXECUTE ON FUNCTION public.decrement_event_booked(UUID)          TO service_role;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, INTEGER, INTEGER)        TO service_role;
GRANT EXECUTE ON FUNCTION public.check_rate_limit_strict(TEXT, TEXT, INTEGER, INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. profiles.is_admin must not be client-writable.
--    profiles_self_update allows UPDATE of the caller's own row; nothing
--    restricts which columns, so any authenticated user could set is_admin
--    and satisfy every admin gate. Column-level UPDATE revoke closes it.
-- ---------------------------------------------------------------------------
REVOKE UPDATE (is_admin) ON public.profiles FROM anon, authenticated, PUBLIC;

-- ---------------------------------------------------------------------------
-- 3. profiles.email must not be readable by the anonymous role.
--    profiles_public_basic_read is USING(true); the caller's own email and
--    organizer contact details remain readable to authenticated users.
-- ---------------------------------------------------------------------------
REVOKE SELECT (email) ON public.profiles FROM anon;

-- ---------------------------------------------------------------------------
-- 4. community_members_self_insert must not let a user self-appoint to a
--    team role (ORGANIZER / MODERATOR / OWNER grant team reads and, for the
--    check-in endpoint, scan authority). Self-service join is "follow" only.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS community_members_self_insert ON public.community_members;
CREATE POLICY community_members_self_insert ON public.community_members
  FOR INSERT WITH CHECK (user_id = auth.uid() AND role = 'MEMBER');

-- ---------------------------------------------------------------------------
-- 5. audit_log is written only by service_role (edge functions). Remove the
--    public INSERT policy and the client table privilege so attackers cannot
--    forge admin audit entries.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS insert_audit_log ON public.audit_log;
REVOKE INSERT ON public.audit_log FROM anon, authenticated, PUBLIC;
