-- ============================================================================
-- CLUVO — Security & RLS Policy Hardening
--
-- 1. community_members_self_delete:
--    - Prevents community owners from deleting their own membership row,
--      preventing orphaned communities without an owner.
--
-- 2. community_applications_applicant_update:
--    - Enforces that applicants resubmitting a rejected application can only
--      set status to 'pending' for re-review.
--    - Restricts column-level UPDATE grants to applicant fields only,
--      preventing unauthorized modification of admin review columns.
-- ============================================================================

-- 1. Prevent community owner from deleting their own membership row
DROP POLICY IF EXISTS community_members_self_delete ON public.community_members;
CREATE POLICY community_members_self_delete ON public.community_members
  FOR DELETE USING (
    user_id = auth.uid() AND role != 'OWNER'
  );

-- 2. Restrict community_applications updates for applicants
DROP POLICY IF EXISTS "community_applications_applicant_update" ON public.community_applications;
CREATE POLICY "community_applications_applicant_update"
  ON public.community_applications
  FOR UPDATE
  USING (auth.uid() = user_id AND status = 'rejected')
  WITH CHECK (auth.uid() = user_id AND status = 'pending');

REVOKE UPDATE ON public.community_applications FROM authenticated;
GRANT UPDATE (
  community_name,
  category,
  description,
  city,
  state,
  country,
  contact_email,
  contact_phone,
  tags,
  rules,
  status
) ON public.community_applications TO authenticated;
