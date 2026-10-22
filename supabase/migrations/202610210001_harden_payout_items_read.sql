-- Harden payout_items RLS: only community owner/team can read payout history
DROP POLICY IF EXISTS "payout_team_read" ON public.payout_items;
CREATE POLICY "payout_team_read" ON public.payout_items FOR SELECT USING (
  public.is_community_owner(community_id) OR public.is_community_team(community_id)
);

-- Ensure admin can still read all payouts
DROP POLICY IF EXISTS "admin_read_all_payouts" ON public.payout_items;
CREATE POLICY "admin_read_all_payouts" ON public.payout_items FOR SELECT
  USING (public.is_admin_user());
