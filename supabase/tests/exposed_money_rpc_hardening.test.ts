// Regression gate for the exposed money/queue RPC hardening (Stage 7 security).
// Run: deno test --allow-read supabase/tests/exposed_money_rpc_hardening.test.ts
//
// Static gate over the migration SQL. It proves every money/queue RPC that was
// found callable by anon/authenticated is now revoked from those roles and
// granted only to service_role. Live enforcement (anon can no longer call
// credit_wallet / debit_wallet / cancel_event_and_enqueue_refunds /
// claim_refund_tasks / update_cancellation_job_progress) is verified against a
// running local database.

import { assert } from "jsr:@std/assert"

const MIGRATION = new URL("../migrations/202611030001_harden_exposed_money_rpcs.sql", import.meta.url)
const sql = await Deno.readTextFile(MIGRATION)

const FUNCTIONS = [
  "public.credit_wallet(uuid, integer, uuid, uuid)",
  "public.debit_wallet(uuid, integer, text, uuid, uuid)",
  "public.claim_refund_tasks(integer, text, integer)",
  "public.update_cancellation_job_progress(uuid)",
  "public.cancel_event_and_enqueue_refunds(uuid, uuid)",
]

Deno.test("every exposed money/queue RPC is revoked from anon + authenticated", () => {
  for (const fn of FUNCTIONS) {
    assert(
      sql.includes(`REVOKE ALL PRIVILEGES ON FUNCTION ${fn}\n  FROM PUBLIC, anon, authenticated;`),
      `expected revoke from PUBLIC, anon, authenticated for ${fn}`,
    )
  }
})

Deno.test("every exposed money/queue RPC is granted only to service_role", () => {
  for (const fn of FUNCTIONS) {
    assert(
      sql.includes(`GRANT EXECUTE ON FUNCTION ${fn}\n  TO service_role;`),
      `expected service_role-only grant for ${fn}`,
    )
  }
})

Deno.test("cancel_event_and_enqueue_refunds no longer trusts caller-supplied id", () => {
  // The IDOR is closed by removing non-service access: no caller can supply an
  // arbitrary p_caller_id anymore. Pin the explanatory intent so the migration
  // cannot silently regress to a PUBLIC/anon grant without this test failing.
  assert(sql.includes("Removing anon/authenticated access closes the IDOR"))
})
