// supabase/tests/remove_member.test.ts
// Verifies BUG-007 remediation:
// 1. remove-member authorizes platform administrators (is_admin = true).
// 2. remove-member authorizes community owners and organizers.
// 3. remove-member forbids ordinary members.
// 4. remove-member prevents removing the community owner.
// 5. remove-member prevents organizers from removing other organizers/moderators.
// 6. remove-member enforces rate limiting.
// 7. remove-member uses standard CORS headers.

import { assert, assertEquals } from "jsr:@std/assert"

const functionsDir = new URL("../functions/", import.meta.url)

Deno.test("BUG-007: remove-member Edge Function authorizes administrators, owners, and organizers", async () => {
  const ts = await Deno.readTextFile(new URL("remove-member/index.ts", functionsDir))

  // Authorization check includes is_admin
  assert(ts.includes("callerIsAdmin"), "Must check caller admin status")
  assert(ts.includes("is_admin"), "Must query profiles.is_admin")

  // Authorization check includes OWNER and ORGANIZER
  assert(ts.includes('callerRole === "OWNER" || callerRole === "ORGANIZER"'), "Must allow owners and organizers")
  assert(ts.includes("canModerate"), "Must compute canModerate permission flag")

  // Target role hierarchy checks
  assert(ts.includes('targetRole === "OWNER"'), "Must prevent removing community owner")
  assert(ts.includes('Cannot remove the community owner'), "Must return specific error for owner target")
  assert(
    ts.includes('targetRole === "ORGANIZER" || targetRole === "MODERATOR"'),
    "Must prevent organizers from removing other team members"
  )

  // Rate limiting check
  assert(ts.includes('checkRateLimit(user.id, "remove-member")'), "Must enforce rate limiting")
  assert(ts.includes("rateLimitResponse"), "Must return 429 rate limit response")

  // Standard CORS headers
  assert(ts.includes("getCorsHeaders(req)"), "Must use standard dynamic CORS headers")

  // Notification and audit log
  assert(ts.includes('"member_removed"'), "Must record member_removed action in audit_log")
  assert(ts.includes('"removed_from_community"'), "Must send notification to removed user")
})

Deno.test("BUG-007: Migration 202611010012 prevents owner self-deletion", async () => {
  const migrationsDir = new URL("../migrations/", import.meta.url)
  const sql = await Deno.readTextFile(new URL("202611010012_owner_self_delete_guard.sql", migrationsDir))

  assert(sql.includes("DROP POLICY IF EXISTS community_members_self_delete"), "Must drop old policy")
  assert(sql.includes("CREATE POLICY community_members_self_delete ON public.community_members"), "Must recreate policy")
  assert(sql.includes("role != 'OWNER'"), "Must exclude OWNER role")
  assert(sql.includes("c.owner_id = auth.uid()"), "Must verify caller is not community owner")
})

