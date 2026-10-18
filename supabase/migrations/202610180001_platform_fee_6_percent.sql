-- ---------------------------------------------------------------------------
-- Percent platform fee: replace the flat ₹20 + 18% GST fee-on-top with
-- commission_percent of the (post-coupon) ticket price, charged on top.
--
-- MODEL (all amounts in paise):
--   ticket (T)              = events.price after any coupon discount
--   fee (F)                 = round(T * communities.commission_percent / 100)
--   charged to customer     = T + F  -> payments.amount
--   organizer wallet credit = T      -> payments.organizer_share
--   platform fee            = F      -> payments.platform_fee
--                                        payments.platform_fee_gst = NULL
-- No GST is charged. The split is still computed ONCE at order creation and
-- read back by confirm_payment / refund paths — this migration changes only
-- where the rate lives and what it applies to.
--
-- commission_percent / commission_on already exist on communities (legacy
-- percent model, 202607240006) and were privileged-column-guarded (0002);
-- no live path read them until now. Existing rows carry the column's old
-- 10.00 default, so an UPDATE is required — the code default alone would
-- change nothing for communities already stored. Migrations run as postgres,
-- which the guard trigger does not block (it only rejects anon/authenticated).
-- ---------------------------------------------------------------------------

ALTER TABLE public.communities
  ALTER COLUMN commission_percent SET DEFAULT 6.00,
  ALTER COLUMN commission_on SET DEFAULT 'post_discount';

UPDATE public.communities
  SET commission_percent = 6.00, commission_on = 'post_discount';

-- The flat pre-GST fee amount is dormant under the percent model. Zeroed for
-- clarity; the column stays (privileged guard + historical readers reference it).
UPDATE public.communities
  SET platform_fee_amount = 0;

COMMENT ON COLUMN public.communities.commission_percent IS
  'Flat platform fee as a percent of the (post-coupon) ticket price, charged on top; organizer receives 100% of the ticket';
COMMENT ON COLUMN public.communities.commission_on IS
  'Kept for schema history: the percent always applies to the post-coupon ticket price';
COMMENT ON COLUMN public.communities.platform_fee_amount IS
  'DEPRECATED — superseded by commission_percent (fee-on-top percent model); no live path reads it';
