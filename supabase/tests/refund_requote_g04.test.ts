// G-04: requote must clear refund_reason, refund_amount_due, refund_attempt_count
//
// Run:
//   deno test --allow-read --allow-env --no-lock --node-modules-dir=none \
//     supabase/tests/refund_requote_g04.test.ts

import { assert, assertEquals } from "jsr:@std/assert"
import {
  clearRefundFieldsForRequote,
  refundFieldsPresent,
} from "../functions/_shared/payments.ts"

Deno.test("clearRefundFieldsForRequote clears reason/due/attempts and archives them", async () => {
  const updates: Record<string, unknown>[] = []
  const inserts: Record<string, unknown>[] = []
  const db = {
    from: (table: string) => {
      if (table === "payment_audit_log") {
        return {
          insert: (row: Record<string, unknown>) => {
            inserts.push(row)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === "payments") {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: (_col: string, _val: unknown) => {
              updates.push(patch)
              return Promise.resolve({ error: null })
            },
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }

  await clearRefundFieldsForRequote(db as any, {
    id: "pay_1",
    status: "failed",
    refund_status: null,
    refund_reason: "event_cancellation",
    refund_amount_due: 750,
    refund_attempt_count: 2,
    razorpay_payment_id: "pay_rzp_123",
    refund_claim_state: "failed",
    razorpay_refund_id: "rfnd_old",
    refunded_amount: 750,
  })

  assertEquals(updates.length, 1)
  assertEquals(updates[0].refund_reason, null)
  assertEquals(updates[0].refund_amount_due, null)
  assertEquals(updates[0].refund_attempt_count, 0)
  assertEquals(updates[0].refund_claim_state, "none")
  assertEquals(updates[0].razorpay_payment_id, null)

  assertEquals(inserts.length, 1)
  const details = inserts[0].details as Record<string, unknown>
  assertEquals(details.prior_refund_reason, "event_cancellation")
  assertEquals(details.prior_refund_amount_due, 750)
  assertEquals(details.prior_refund_attempt_count, 2)
})

Deno.test("refundFieldsPresent true when reason/due/attempts present", () => {
  assertEquals(refundFieldsPresent({ status: "failed", refund_reason: "capacity_full" }), true)
  assertEquals(refundFieldsPresent({ status: "failed", refund_amount_due: 100 }), true)
  assertEquals(refundFieldsPresent({ status: "failed", refund_attempt_count: 1 }), true)
})

const paymentsSrc = await Deno.readTextFile(
  new URL("../functions/_shared/payments.ts", import.meta.url),
)
Deno.test("clearRefundFieldsForRequote clears all three G-04 fields", () => {
  assert(paymentsSrc.includes("refund_reason: null"))
  assert(paymentsSrc.includes("refund_amount_due: null"))
  assert(paymentsSrc.includes("refund_attempt_count: 0"))
})

const createPaymentSrc = await Deno.readTextFile(
  new URL("../functions/create-payment/index.ts", import.meta.url),
)
Deno.test("create-payment selects and clears refund debt fields", () => {
  assert(createPaymentSrc.includes("refund_attempt_count"))
  assert(createPaymentSrc.includes("clearRefundFieldsForRequote"))
})

const createPaymentOrderSrc = await Deno.readTextFile(
  new URL("../functions/create-payment-order/index.ts", import.meta.url),
)
Deno.test("create-payment-order selects and clears refund debt fields", () => {
  assert(createPaymentOrderSrc.includes("refund_attempt_count"))
  assert(createPaymentOrderSrc.includes("clearRefundFieldsForRequote"))
})
