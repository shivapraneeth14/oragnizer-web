// Community deletion scheduling (30-day grace) tests
//
// Run:
//   deno test --allow-read --allow-env --no-lock --node-modules-dir=none \
//     supabase/tests/community_deletion_schedule.test.ts

import { assert, assertEquals } from "jsr:@std/assert"

const mig = await Deno.readTextFile(
  new URL("../migrations/202610280002_community_deletion_grace.sql", import.meta.url),
)
const adminDel = await Deno.readTextFile(
  new URL("../functions/admin-delete-community/index.ts", import.meta.url),
)
const cancelFn = await Deno.readTextFile(
  new URL("../functions/admin-cancel-community-deletion/index.ts", import.meta.url),
)
const purge = await Deno.readTextFile(
  new URL("../functions/purge-deleted-accounts/index.ts", import.meta.url),
)

Deno.test("communities have grace columns and claim RPC", () => {
  assert(mig.includes("deletion_grace_started_at"))
  assert(mig.includes("deletion_purging_at"))
  assert(mig.includes("claim_due_community_deletions"))
  assert(mig.includes("FOR UPDATE SKIP LOCKED"))
})

Deno.test("admin-delete-community schedules with grace period", () => {
  assert(adminDel.includes("deletion_grace_started_at"))
  assert(adminDel.includes("is_hidden"))
  assert(adminDel.includes("GRACE_DAYS"))
  assert(adminDel.includes("is_hidden_before_deletion"))
})

Deno.test("admin-cancel-community-deletion exists and clears grace", () => {
  assert(cancelFn.includes("deletion_grace_started_at"))
  assert(cancelFn.includes("deletion_purging_at"))
  assert(cancelFn.includes("is_hidden"))
  assert(cancelFn.includes("is_hidden_before_deletion"))
})

Deno.test("purge handles communities", () => {
  assert(purge.includes("claim_due_community_deletions"))
  assert(purge.includes("closed_at") || purge.includes("community_closed"))
})
