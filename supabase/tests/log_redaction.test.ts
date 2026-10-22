// PII log-redaction contract.
// Run: deno test supabase/tests/log_redaction.test.ts
//
// Edge-function logs are external to the database and outside the deletion
// path, so they must never contain emails, bearer tokens, JWTs, or long hex.

import { assert, assertEquals } from "jsr:@std/assert"
import { redact, safeMessage } from "../functions/_shared/logger.ts"

Deno.test("redact removes email addresses", () => {
  assertEquals(
    redact("user supp.cluvo@gmail.com failed"),
    "user [email] failed",
  )
})

Deno.test("redact removes bearer tokens and JWTs", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"
  const out = redact(`Authorization: Bearer ${jwt}`)
  assert(!out.includes(jwt))
  assert(out.includes("[jwt]") || out.includes("[token]"))
})

Deno.test("redact removes long hex (hashes/keys)", () => {
  const hex = "a".repeat(64)
  assert(!redact(`sig=${hex}`).includes(hex))
})

Deno.test("safeMessage truncates and redacts object errors", () => {
  const msg = safeMessage({ message: `leak ${"b".repeat(400)} admin@example.com` })
  assert(msg.length <= 300)
  assert(!msg.includes("admin@example.com"))
})
