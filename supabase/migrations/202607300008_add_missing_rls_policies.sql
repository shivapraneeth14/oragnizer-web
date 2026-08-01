-- ============================================================================
-- Add RLS policies for tables that have RLS enabled but zero policies
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. COUPONS — community-scoped discount codes
-- ---------------------------------------------------------------------------
-- SELECT: any team member (owner, moderator, organizer) can see coupons for their community
-- INSERT/UPDATE: team members can create/update coupons
-- DELETE: only the community owner can delete
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'coupons' AND policyname = 'coupons_team_read'
  ) THEN
    CREATE POLICY "coupons_team_read" ON coupons
      FOR SELECT USING (
        community_id IN (
          SELECT id FROM communities WHERE owner_id = auth.uid()
          UNION
          SELECT community_id FROM community_members WHERE user_id = auth.uid()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'coupons' AND policyname = 'coupons_team_insert'
  ) THEN
    CREATE POLICY "coupons_team_insert" ON coupons
      FOR INSERT WITH CHECK (
        community_id IN (
          SELECT id FROM communities WHERE owner_id = auth.uid()
          UNION
          SELECT community_id FROM community_members WHERE user_id = auth.uid()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'coupons' AND policyname = 'coupons_team_update'
  ) THEN
    CREATE POLICY "coupons_team_update" ON coupons
      FOR UPDATE USING (
        community_id IN (
          SELECT id FROM communities WHERE owner_id = auth.uid()
          UNION
          SELECT community_id FROM community_members WHERE user_id = auth.uid()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'coupons' AND policyname = 'coupons_owner_delete'
  ) THEN
    CREATE POLICY "coupons_owner_delete" ON coupons
      FOR DELETE USING (
        community_id IN (SELECT id FROM communities WHERE owner_id = auth.uid())
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'coupons' AND policyname = 'admin_read_all_coupons'
  ) THEN
    CREATE POLICY "admin_read_all_coupons" ON coupons
      FOR SELECT USING (public.is_admin_user());
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. WAITLIST_ENTRIES — event waitlist, user-scoped + team access
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'waitlist_entries' AND policyname = 'waitlist_self_read'
  ) THEN
    CREATE POLICY "waitlist_self_read" ON waitlist_entries
      FOR SELECT USING (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'waitlist_entries' AND policyname = 'waitlist_self_insert'
  ) THEN
    CREATE POLICY "waitlist_self_insert" ON waitlist_entries
      FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'waitlist_entries' AND policyname = 'waitlist_self_delete'
  ) THEN
    CREATE POLICY "waitlist_self_delete" ON waitlist_entries
      FOR DELETE USING (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'waitlist_entries' AND policyname = 'waitlist_team_read'
  ) THEN
    CREATE POLICY "waitlist_team_read" ON waitlist_entries
      FOR SELECT USING (
        event_id IN (
          SELECT e.id FROM events e
          WHERE e.community_id IN (
            SELECT id FROM communities WHERE owner_id = auth.uid()
            UNION
            SELECT community_id FROM community_members WHERE user_id = auth.uid()
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'waitlist_entries' AND policyname = 'waitlist_team_delete'
  ) THEN
    CREATE POLICY "waitlist_team_delete" ON waitlist_entries
      FOR DELETE USING (
        event_id IN (
          SELECT e.id FROM events e
          WHERE e.community_id IN (
            SELECT id FROM communities WHERE owner_id = auth.uid()
            UNION
            SELECT community_id FROM community_members WHERE user_id = auth.uid()
          )
        )
      );
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. PLANS — pricing / feature plans (system-managed)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'plans' AND policyname = 'plans_public_read'
  ) THEN
    CREATE POLICY "plans_public_read" ON plans
      FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'plans' AND policyname = 'plans_admin_all'
  ) THEN
    CREATE POLICY "plans_admin_all" ON plans
      FOR ALL USING (public.is_admin_user());
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. COMMUNITY_SUBSCRIPTIONS — community → plan mapping
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'community_subscriptions' AND policyname = 'subscriptions_owner_read'
  ) THEN
    CREATE POLICY "subscriptions_owner_read" ON community_subscriptions
      FOR SELECT USING (
        community_id IN (SELECT id FROM communities WHERE owner_id = auth.uid())
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'community_subscriptions' AND policyname = 'subscriptions_admin_all'
  ) THEN
    CREATE POLICY "subscriptions_admin_all" ON community_subscriptions
      FOR ALL USING (public.is_admin_user());
  END IF;
END;
$$;
