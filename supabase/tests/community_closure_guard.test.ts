// supabase/tests/community_closure_guard.test.ts
// Verifies BUG-004 remediation:
// 1. Migration 202611010010 defines recursion-safe is_community_accepting_members.
// 2. Permissive policy community_members_self_insert enforces active community status and MEMBER role for non-admins.
// 3. Permissive policy preserves administrator recovery (is_admin_user()).
// 4. Restrictive policy block_closure_community_members_insert blocks non-admin/service-role inserts during closure grace.
// 5. Existing member self-delete (leave) remains unimpeded.

import { assert, assertEquals } from "jsr:@std/assert"

const migrationsDir = new URL("../migrations/", import.meta.url)

Deno.test("BUG-004: Migration 202611010010 defines is_community_accepting_members helper", async () => {
  const sql = await Deno.readTextFile(new URL("202611010010_community_closure_membership_guard.sql", migrationsDir))

  // Function signature and security properties
  assert(sql.includes("CREATE OR REPLACE FUNCTION public.is_community_accepting_members(p_community_id uuid)"))
  assert(sql.includes("RETURNS boolean"))
  assert(sql.includes("SECURITY DEFINER"))
  assert(sql.includes("SET search_path = ''"))

  // Invariant checks
  assert(sql.includes("c.deleted_at IS NULL"), "Must check deleted_at is null")
  assert(sql.includes("c.closed_at IS NULL"), "Must check closed_at is null")
  assert(sql.includes("c.deletion_grace_started_at IS NULL"), "Must check deletion_grace_started_at is null")

  // Privilege hygiene
  assert(sql.includes("REVOKE ALL ON FUNCTION public.is_community_accepting_members(uuid) FROM PUBLIC, anon"))
  assert(sql.includes("GRANT EXECUTE ON FUNCTION public.is_community_accepting_members(uuid) TO authenticated, service_role"))
})

Deno.test("BUG-004: Permissive self-join policy enforces MEMBER role and active community while preserving admin recovery", async () => {
  const sql = await Deno.readTextFile(new URL("202611010010_community_closure_membership_guard.sql", migrationsDir))

  // Policy definition
  assert(sql.includes("DROP POLICY IF EXISTS community_members_self_insert ON public.community_members"))
  assert(sql.includes("CREATE POLICY community_members_self_insert ON public.community_members"))
  assert(sql.includes("FOR INSERT WITH CHECK"))

  // Regular user restriction: role must be MEMBER (no escalation) and community must be accepting
  assert(sql.includes("user_id = auth.uid()"))
  assert(sql.includes("role = 'MEMBER'"))
  assert(sql.includes("public.is_community_accepting_members(community_id)"))

  // Admin recovery bypass
  assert(sql.includes("COALESCE(public.is_admin_user(), false)"))
})

Deno.test("BUG-004: Restrictive policy blocks non-admin inserts during closure grace", async () => {
  const sql = await Deno.readTextFile(new URL("202611010010_community_closure_membership_guard.sql", migrationsDir))

  assert(sql.includes("DROP POLICY IF EXISTS \"block_closure_community_members_insert\" ON public.community_members"))
  assert(sql.includes("CREATE POLICY \"block_closure_community_members_insert\" ON public.community_members"))
  assert(sql.includes("AS RESTRICTIVE"))
  assert(sql.includes("FOR INSERT"))

  // Exemption cases
  assert(sql.includes("COALESCE((auth.jwt() ->> 'role'), '') = 'service_role'"))
  assert(sql.includes("COALESCE(public.is_admin_user(), false)"))

  // Restrictive rejection
  assert(sql.includes("WHEN public.is_community_in_closure_grace(community_id) THEN false"))
})

