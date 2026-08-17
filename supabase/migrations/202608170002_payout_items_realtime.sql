-- ============================================================================
-- CLUVO - PASS 2: build live payout updates in the organizer web
-- Cashfree webhook → payout_items row change → realtime channel pushes the
-- withdrawal's proof fields (status/utr/reason/refunded) to the open Payout
-- page without any refresh. RLS already restricts payout_items reads to the
-- community owner/members, so only their own rows reach the channel.
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.payout_items;