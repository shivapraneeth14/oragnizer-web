// Account-deletion grace-period contract tests.
// Run: deno test supabase/tests/account_deletion.test.ts
//
// These are pure-logic tests for the shared helpers used by delete-account,
// cancel-account-deletion, purge-deleted-accounts, and the money-path guards.
// Live-DB behaviour (RLS, claim_due_deletions locked rows) is covered by the
// migration gate below and is UNVERIFIED-PENDING-DEPLOY until the disposable
// two-phase database run is wired into CI.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert"
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2"
import {
  cloudinaryPublicId,
  DELETION_PENDING_MESSAGE,
  deletionGraceForbiddenResponse,
  deletionPendingResponse,
  getDeletionGrace,
  GRACE_DAYS,
  graceDueAt,
  isDeletionPending,
  isGraceExpired,
} from "../functions/_shared/deletion.ts"

const DAY_MS = 24 * 60 * 60 * 1000

function mockClient(row: { deletion_grace_started_at: string | null } | null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

Deno.test("grace period is 30 days", () => {
  assertEquals(GRACE_DAYS, 30)
})

Deno.test("graceDueAt adds exactly 30 days", () => {
  const start = new Date("2026-10-01T00:00:00.000Z")
  assertEquals(graceDueAt(start).toISOString(), "2026-10-31T00:00:00.000Z")
})

Deno.test("isGraceExpired is false one millisecond before due", () => {
  const start = new Date("2026-10-01T00:00:00.000Z")
  const justBefore = new Date(start.getTime() + 30 * DAY_MS - 1)
  assertEquals(isGraceExpired(start, justBefore), false)
})

Deno.test("isGraceExpired is true at the due instant", () => {
  const start = new Date("2026-10-01T00:00:00.000Z")
  assertEquals(isGraceExpired(start, graceDueAt(start)), true)
})

Deno.test("isGraceExpired is true after the due instant", () => {
  const start = "2026-01-01T00:00:00.000Z"
  assertEquals(isGraceExpired(start, new Date("2026-03-01T00:00:00.000Z")), true)
})

Deno.test("cloudinaryPublicId extracts a versioned avatar path", () => {
  assertEquals(
    cloudinaryPublicId(
      "https://res.cloudinary.com/cluvo/image/upload/v1729000000/avatars/user_abc.jpg",
    ),
    "avatars/user_abc",
  )
})

Deno.test("cloudinaryPublicId extracts an unversioned avatar path", () => {
  assertEquals(
    cloudinaryPublicId("https://res.cloudinary.com/cluvo/image/upload/avatars/a1.png"),
    "avatars/a1",
  )
})

Deno.test("cloudinaryPublicId returns null for a null/blank URL", () => {
  assertEquals(cloudinaryPublicId(null), null)
  assertEquals(cloudinaryPublicId(""), null)
})

Deno.test("cloudinaryPublicId returns null for non-Cloudinary URLs", () => {
  assertEquals(cloudinaryPublicId("https://avatars.githubusercontent.com/u/1.png"), null)
})

Deno.test("getDeletionGrace returns the stored grace timestamp", async () => {
  const ts = "2026-10-22T10:00:00.000Z"
  const client = mockClient({ deletion_grace_started_at: ts })
  assertEquals(await getDeletionGrace(client, "user-1"), ts)
})

Deno.test("getDeletionGrace returns null when no grace is active", async () => {
  assertEquals(await getDeletionGrace(mockClient(null), "user-1"), null)
  assertEquals(
    await getDeletionGrace(mockClient({ deletion_grace_started_at: null }), "user-1"),
    null,
  )
})

Deno.test("isDeletionPending reflects grace presence", async () => {
  assertEquals(
    await isDeletionPending(mockClient({ deletion_grace_started_at: "2026-10-22T00:00:00Z" }), "u"),
    true,
  )
  assertEquals(await isDeletionPending(mockClient(null), "u"), false)
})

Deno.test("deletionPendingResponse is a 409 with deletion_grace flag", async () => {
  const res = deletionPendingResponse()
  assertEquals(res.status, 409)
  assertEquals(res.headers.get("Content-Type"), "application/json")
  const body = await res.json()
  assertEquals(body.error, DELETION_PENDING_MESSAGE)
  assertEquals(body.deletion_grace, true)
})

Deno.test("deletionGraceForbiddenResponse is a 403 with deletion_grace flag", async () => {
  const res = deletionGraceForbiddenResponse()
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body.deletion_grace, true)
  assertStringIncludes(body.error, "scheduled for permanent deletion")
})

Deno.test("deletion message tells the user how to restore", () => {
  assertStringIncludes(DELETION_PENDING_MESSAGE, "Keep my account")
})

Deno.test("a fresh grace request is not immediately expired", () => {
  const now = new Date("2026-10-22T12:00:00.000Z")
  assert(!isGraceExpired(now, now))
})
