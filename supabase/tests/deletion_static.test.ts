// Static regression tests for the deletion/purge/admin code paths.
// Run: deno test supabase/tests/deletion_static.test.ts

import { assert, assertEquals } from "jsr:@std/assert"
import {
  daysRemaining,
  deletionDueAt,
  GRACE_DAYS,
} from "../../apps/admin-web/src/lib/deletion.ts"

const DAY_MS = 24 * 60 * 60 * 1000

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, import.meta.url))
}

const deleteAccount = await read("../functions/delete-account/index.ts")
const purge = await read("../functions/purge-deleted-accounts/index.ts")
const adminUndelete = await read("../functions/admin-undelete-user/index.ts")
const adminList = await read("../functions/admin-list-profiles/index.ts")

Deno.test("admin daysRemaining matches GRACE_DAYS boundaries", () => {
  assertEquals(GRACE_DAYS, 30)
  const start = "2026-10-01T00:00:00.000Z"
  const startMs = new Date(start).getTime()

  assertEquals(deletionDueAt(start).toISOString(), "2026-10-31T00:00:00.000Z")
  assertEquals(daysRemaining(start, startMs), 30)
  assertEquals(daysRemaining(start, startMs + 29 * DAY_MS), 1)
  assertEquals(daysRemaining(start, startMs + 30 * DAY_MS - 1), 1)
  assertEquals(daysRemaining(start, startMs + 30 * DAY_MS), 0)
  assertEquals(daysRemaining(start, startMs + 31 * DAY_MS), 0)
})

Deno.test("delete-account payment guards are scoped to the deleting user", () => {
  const scopedPayments = deleteAccount.match(
    /\.from\("payments"\)\s*\.select\("id,\s*registrations!inner\(user_id\)"\)\s*\.eq\("registrations\.user_id",\s*userId\)/g,
  )
  assertEquals(scopedPayments?.length, 3)
  assert(deleteAccount.includes('signOut(token, "global")'))
  assert(!deleteAccount.includes("signOut(user.id)"))
})

Deno.test("purge uses the real refund column and never the phantom waitlist table", () => {
  assert(purge.includes("refund_claim_state.eq.claimed"))
  assert(!purge.includes("refund_claim_state.eq.clared"))
  assert(!purge.includes('.from("waitlist")'))
  assert(!purge.includes("reporter_email"))
  assert(purge.includes("details.replaceAll(email, \"[redacted]\")"))
})

Deno.test("admin restore clears grace/purge state and audits without email", () => {
  assert(adminUndelete.includes("deletion_grace_started_at"))
  assert(adminUndelete.includes("deletion_purging_at"))
  assert(adminUndelete.includes("deletion_cancelled_by_admin"))
  assert(adminUndelete.includes("details: { mode:"))
  assert(!adminUndelete.includes("details: { email"))
})

Deno.test("admin list supports scheduled-only and excludes grace from active", () => {
  assert(adminList.includes("scheduled_only"))
  assert(adminList.includes('.not("deletion_grace_started_at", "is", null)'))
  assert(adminList.includes('.is("deletion_grace_started_at", null)'))
})
