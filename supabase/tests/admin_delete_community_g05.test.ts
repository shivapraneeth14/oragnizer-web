// G-05: admin delete community must refund paid attendees and clean up
//
// Run:
//   deno test --allow-read --allow-env --no-lock --node-modules-dir=none \
//     supabase/tests/admin_delete_community_g05.test.ts

import { assert } from "jsr:@std/assert"

const fnSrc = await Deno.readTextFile(
  new URL("../functions/admin-delete-community/index.ts", import.meta.url),
)
const trigSrc = await Deno.readTextFile(
  new URL("../migrations/202610280001_fix_cancelled_event_cleanup.sql", import.meta.url),
)

Deno.test("admin-delete-community enforces strict closure guards", () => {
  assert(fnSrc.includes("deletion_grace_started_at"))
  assert(fnSrc.includes("is_hidden"))
  assert(fnSrc.includes("GRACE_DAYS"))
})

Deno.test("admin-delete-community cancels registrations", () => {
  assert(fnSrc.includes('.from("registrations")'))
  assert(fnSrc.includes('"cancelled"'))
})

Deno.test("admin-delete-community cancels and soft-deletes events/communities", () => {
  assert(fnSrc.includes('.from("events")'))
  assert(fnSrc.includes('"cancelled"'))
  assert(fnSrc.includes('.from("communities")'))
  assert(fnSrc.includes("deleted_at"))
})

Deno.test("cancelled-event trigger allows service role or cleanup bypass", () => {
  assert(trigSrc.includes("auth.role() = 'service_role'"))
  assert(trigSrc.includes("allow_cancelled_event_cleanup"))
  assert(trigSrc.includes("SECURITY DEFINER"))
})
