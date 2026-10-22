// P1/P4b: ghost-refund guard + re-quote hygiene + atomic restore.
// Run: deno test --allow-env supabase/tests/refund_webhook_requote_guard.test.ts
//
// The ghost-refund bug: a payment row REUSED for a new sale kept the previous
// capture's razorpay_payment_id; a late refund webhook for the OLD payment
// matched the row by that id and marked the NEW booking 'refunded'.

import { assert, assertEquals } from "jsr:@std/assert"
import {
  clearRefundFieldsForRequote,
  paymentNonRequotableReason,
  refundSyncRowTrustworthy,
  restoreRegistrationIfCancelled,
} from "../functions/_shared/payments.ts"

function makeMockSupabase() {
  const calls: Array<{ table: string; op: string; payload: any; filters: Array<[string, any]> }> = []
  return {
    calls,
    from(table: string) {
      const entry = { table, op: "", payload: null as any, filters: [] as Array<[string, any]> }
      calls.push(entry)
      const chain: any = {
        insert(payload: any) { entry.op = "insert"; entry.payload = payload; return chain },
        update(payload: any) { entry.op = "update"; entry.payload = payload; return chain },
        eq(col: string, val: any) { entry.filters.push([col, val]); return chain },
        select() { return chain },
        maybeSingle() { return Promise.resolve({ data: null }) },
        single() { return Promise.resolve({ data: null }) },
      }
      return chain
    },
  }
}

Deno.test("requote clears the prior capture id and archives it to the audit log", async () => {
  const db = makeMockSupabase()
  await clearRefundFieldsForRequote(db as any, {
    id: "pay_1",
    status: "refunded",
    refund_status: "processed",
    refund_claim_state: "issued",
    razorpay_payment_id: "payid_old",
    razorpay_refund_id: "ref_old",
    refunded_amount: 1000,
  })

  const audit = db.calls.find((c) => c.op === "insert")
  assertEquals(audit?.table, "payment_audit_log")
  assertEquals(audit?.payload.details.prior_razorpay_payment_id, "payid_old", "old capture id archived")

  const update = db.calls.find((c) => c.op === "update")
  assertEquals(update?.table, "payments")
  assertEquals(update?.payload.razorpay_payment_id, null, "old capture id cleared — no ghost match possible")
  assertEquals(update?.payload.refund_status, null)
  assertEquals(update?.payload.refund_claim_state, "none")
  assertEquals(update?.payload.razorpay_refund_id, null)
  assertEquals(update?.filters, [["id", "pay_1"]])
})

Deno.test("requote with a bare prior capture id (legacy row, no refund fields) still clears it", async () => {
  const db = makeMockSupabase()
  await clearRefundFieldsForRequote(db as any, {
    id: "pay_2",
    status: "pending",
    razorpay_payment_id: "payid_legacy",
  })
  const update = db.calls.find((c) => c.op === "update")
  assertEquals(update?.payload.razorpay_payment_id, null)
})

Deno.test("requote on a clean row (no refund leftovers, no capture id) is a no-op", async () => {
  const db = makeMockSupabase()
  await clearRefundFieldsForRequote(db as any, {
    id: "pay_3",
    status: "pending",
    refund_status: null,
    refund_claim_state: "none",
    razorpay_payment_id: null,
  })
  assertEquals(db.calls.length, 0, "nothing to clear, nothing written")
})

Deno.test("restoreRegistrationIfCancelled only updates rows still 'cancelled' (atomic)", async () => {
  const db = makeMockSupabase()
  await restoreRegistrationIfCancelled(db as any, "reg_1")
  const update = db.calls.find((c) => c.op === "update")
  assertEquals(update?.table, "registrations")
  // The conditional eq is the race fix: a stale snapshot can never overwrite
  // a status another flow already moved.
  assertEquals(update?.filters, [["id", "reg_1"], ["status", "cancelled"]])
  assertEquals(update?.payload.status, "pending")
  assertEquals(update?.payload.deleted_at, null)
})

Deno.test("webhook fallback match: a fresh re-quoted row is never trusted", () => {
  // The ghost: pending row for a NEW sale still carrying the old capture id.
  assertEquals(refundSyncRowTrustworthy({
    refund_claim_state: "none",
    refund_status: null,
    status: "pending",
  }), false)
})

Deno.test("webhook fallback match: rows inside the refund claim machine are trusted", () => {
  assertEquals(refundSyncRowTrustworthy({ refund_claim_state: "claimed", refund_status: null, status: "success" }), true)
  assertEquals(refundSyncRowTrustworthy({ refund_sync: null, refund_claim_state: "issued", refund_status: "processed", status: "refunded" } as any), true)
  assertEquals(refundSyncRowTrustworthy({ refund_claim_state: "failed", refund_status: "failed", status: "success" }), true)
  assertEquals(refundSyncRowTrustworthy({ refund_claim_state: "none", refund_status: "pending", status: "success" }), true)
  assertEquals(refundSyncRowTrustworthy({ refund_claim_state: "none", refund_status: null, status: "refunded" }), true)
})

Deno.test("gate still blocks paid and refunding rows", () => {
  assertEquals(paymentNonRequotableReason({ status: "success" }), "already_paid")
  assertEquals(paymentNonRequotableReason({ status: "pending", refund_claim_state: "claimed" }), "refund_in_progress")
  assertEquals(paymentNonRequotableReason({ status: "pending", refund_status: "pending" }), "refund_in_progress")
  assertEquals(paymentNonRequotableReason({ status: "pending", refund_claim_state: "none", refund_status: null }), null)
})
