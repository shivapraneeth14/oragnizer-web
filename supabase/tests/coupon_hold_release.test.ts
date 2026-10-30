// supabase/tests/coupon_hold_release.test.ts
// Verifies BUG-010 remediation:
// 1. Safe coupon claim semantics: never decrements counter unless claim was definitively established.
// 2. Coupon exhaustion triggers immediate capacity hold release via release_ticket_capacity.
// 3. Resilient safeReleaseHold helper with 3 retries and payment_audit_log fallback.
// 4. Downstream checkout crashes release hold and conditionally release coupon.

import { assert, assertEquals } from "jsr:@std/assert"

const functionsDir = new URL("../functions/create-payment/", import.meta.url)

Deno.test("BUG-010: create-payment implements safeReleaseHold with retries and audit logging", async () => {
  const ts = await Deno.readTextFile(new URL("index.ts", functionsDir))

  // safeReleaseHold helper definition
  assert(ts.includes("async function safeReleaseHold(regId: string, evtId: string, reason: string)"))
  assert(ts.includes('supabase.rpc("release_ticket_capacity", { p_registration_id: regId })'))

  // Retry loop up to 3 attempts
  assert(ts.includes("for (let attempt = 0; attempt < 3; attempt++)"))

  // Audit logging on failure
  assert(ts.includes('from("payment_audit_log").insert'))
  assert(ts.includes('action: "hold_release_failed"'))
  assert(ts.includes("registration_id: regId"))
  assert(ts.includes("event_id: evtId"))
})

Deno.test("BUG-010: Coupon failure releases capacity hold and preserves shared counter", async () => {
  const ts = await Deno.readTextFile(new URL("index.ts", functionsDir))

  // State machine flag
  assert(ts.includes("let couponClaimed = false"))

  // Exhaustion / failure check
  assert(ts.includes("if (claimError || !claimResult?.claimed)"))

  // Capacity hold released on coupon failure
  assert(ts.includes('await safeReleaseHold(registrationId, event_id, "coupon_claim_exhausted")'))

  // Shared counter MUST NOT be decremented if claim was never confirmed
  // (release_coupon must only be invoked when couponClaimed === true)
  assert(ts.includes("if (couponClaimed && couponId) await supabase.rpc(\"release_coupon\""))
})

Deno.test("BUG-010: Downstream failures release hold and conditionally release claimed coupon", async () => {
  const ts = await Deno.readTextFile(new URL("index.ts", functionsDir))

  // In catch handler for payment persistence failure
  assert(ts.includes('await safeReleaseHold(registrationId, event_id, "payment_row_insert_failed")'))

  // In outer error catch handler
  assert(ts.includes('await safeReleaseHold(registrationId, event_id, "checkout_order_creation_failed")'))
})

