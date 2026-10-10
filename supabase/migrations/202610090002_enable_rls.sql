-- Ensure RLS is enabled for tables that were created without it in the repo.
-- Production already has these enabled (applied out-of-band), so on live this is
-- a no-op; it exists so a fresh rebuild from migrations matches production.
--
-- Note: the two internal tables are additionally locked down so no app user can
-- reach them; they already run with RLS on and zero policies (deny-all).

SET lock_timeout = '3s';

ALTER TABLE public.waitlist_entries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupons                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processed_webhooks      ENABLE ROW LEVEL SECURITY;

-- Internal system tables: no anon/authenticated access at all.
REVOKE ALL ON TABLE public.rate_limits        FROM anon, authenticated;
REVOKE ALL ON TABLE public.processed_webhooks FROM anon, authenticated;
