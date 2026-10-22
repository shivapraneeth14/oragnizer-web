// P4: cancel/checkout race invariants.
//   deno test --allow-env supabase/tests/cancel_checkout_interleavings.test.ts
//
// The handlers bind Deno.serve at import time, so their internal ORDER cannot
// be unit-executed. These are tripwires that pin the exact ordering/guards
// against regression; the behavioural half (atomic conditional restore,
// clear-once re-quote) is tested in refund_webhook_requote_guard.test.ts and
// the SQL guard is pinned against the shipped migration here.

import { assert, assertEquals } from "jsr:@std/assert"

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url))

Deno.test("cancel-registration cancels BEFORE it tries to refund", async () => {
  const src = await read("../functions/cancel-registration/index.ts")
  const cancelAt = src.indexOf('await supabase.rpc("cancel_registration_and_decrement"')
  const refundAt = src.indexOf("await attemptRefund(")
  assert(cancelAt >= 0, "cancel RPC present")
  assert(refundAt >= 0, "refund attempt present")
  assert(
    cancelAt < refundAt,
    "registration must be cancelled first: a refund failure cannot leave a live confirmed booking on refunded money",
  )
  assert(
    src.includes("Registration already cancelled — reconcile will retry"),
    "refund failure after cancel must be audited for reconcile",
  )
})

Deno.test("checkout never restores a cancelled booking before the paid/refunding gate", async () => {
  const src = await read("../functions/create-payment/index.ts")
  const gateAt = src.indexOf("paymentNonRequotableReason(")
  const restoreAt = src.indexOf("restoreRegistrationIfCancelled(supabase")
  assert(gateAt >= 0 && restoreAt >= 0)
  assert(
    gateAt < restoreAt,
    "restore must run only after the row is proven re-quotable (else money is in flight)",
  )
})

Deno.test("re-quote archives and clears stale refund fields before persisting the new order", async () => {
  const src = await read("../functions/create-payment/index.ts")
  const clearAt = src.indexOf("clearRefundFieldsForRequote(supabase")
  // The re-quote update that demotes the row to 'pending'.
  const requoteAt = src.indexOf("razorpay_order_id: order.id,")
  assert(clearAt >= 0 && requoteAt >= 0)
  assert(clearAt < requoteAt, "stale refund/capture fields cleared before the new sale owns the row")
})

Deno.test("confirm_payment refuses to resurrect a cancelled registration (SQL guard shipped)", async () => {
  const sql = await read("../migrations/202610220005_confirm_payment_no_resurrect_cancelled.sql")
  assert(sql.includes("'cancelled'"), "reads cancelled status")
  assert(sql.includes("'refund_required'"), "flips to refund_required instead of confirmed")
  assert(sql.includes("'registration_cancelled'"), "persists the auto-refund reason")
  assert(sql.includes("refund_required"), "guard present in confirm_payment")
})

Deno.test("refund policy integrity migration persists due/reason once and archives history", async () => {
  const sql = await read("../migrations/202610220004_refund_policy_integrity.sql")
  assert(sql.includes("refund_amount_due"), "owed amount column")
  assert(sql.includes("refund_reason"), "cancellation type column")
  assert(/COALESCE\s*\(\s*refund_reason/.test(sql), "reason persisted once via COALESCE")
  assert(/COALESCE\s*\(\s*refund_amount_due/.test(sql), "owed amount persisted once via COALESCE")
  assert(sql.includes("payment_refund_history"), "refund archive table")
  assert(sql.includes("INSERT INTO public.payment_refund_history"), "settled refunds archived")
  assertEquals(
    /REVOKE[\s\S]*claim_payment_refund[\s\S]*FROM[^;]*PUBLIC/i.test(sql) ||
      /REVOKE[^;]*claim_payment_refund[^;]*FROM[^;]*PUBLIC/i.test(sql),
    true,
    "refund claim is not callable by anon/authenticated",
  )
})
