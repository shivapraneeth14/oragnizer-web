-- ============================================================================
-- CLUVO - PASS 2: add payments to the realtime publication
-- Powers the payment-detail screen's live refund status updates. Only the
-- owning user's rows pass RLS, so other users' payment data never leaks
-- through the channel.
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.payments;