// G-02: a failed payment with a recorded refund debt must not be re-quoted,
// and refund debt must be cleared on requote. NULL refund_status must not
// block recovery once the debt is recorded or once we force a sweep.
//
// Run:
//   deno test --allow-read --allow-env --no-lock --node-modules-dir=none \
//     supabase/tests/refund_debt_g02.test.ts

import { assert, assertEquals } from "jsr:@std/assert"
import {
  hasRecordedRefundDebt,
  paymentNonRequotableReason,
  clearRefundFieldsForRequote,
  refundFieldsPresent,
} from "../functions/_shared/payments.ts"

Deno.test("hasRecordedRefundDebt is true for due amount or reason", () => {
  assertEquals(hasRecordedRefundDebt({ status: "failed", refund_amount_due: 500 }), true)
  assertEquals(hasRecordedRefundDebt({ status: "failed", refund_reason: "event_cancellation" }), true)
  assertEquals(hasRecordedRefundDebt({ status: "failed", refund_amount_due: 0 }), false)
  assertEquals(hasRecordedRefundDebt({ status: "failed" }), false)
})

Deno.test("failed payment with recorded debt blocks requote even if refund_status is null", () => {
  assertEquals(
    paymentNonRequotableReason({
      status: "failed",
      refund_status: null,
      refund_reason: "event_cancellation",
      refund_amount_due: 500,
    }),
    "refund_in_progress",
  )
})

Deno.test("plain failed checkout with no debt can be re-quoted", () => {
  assertEquals(
    paymentNonRequotableReason({
      status: "failed",
      refund_status: null,
    }),
    null,
  )
})

Deno.test("refundFieldsPresent includes debt", () => {
  assertEquals(
    refundFieldsPresent({ status: "failed", refund_reason: "registration_cancellation" }),
    true,
  )
  assertEquals(
    refundFieldsPresent({ status: "failed", refund_amount_due: 100 }),
    true,
  )
})

Deno.test("clearRefundFieldsForRequote clears debt fields too", async () => {
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
    refund_amount_due: 500,
    refund_attempt_count: 3,
    razorpay_payment_id: "pay_rzp",
  })

  assertEquals(inserts.length, 1)
  assertEquals(updates.length, 1)
  assertEquals(updates[0].refund_reason, null)
  assertEquals(updates[0].refund_amount_due, null)
  assertEquals(updates[0].refund_attempt_count, 0)
})

// Source tripwires
const paymentsSrc = await Deno.readTextFile(
  new URL("../functions/_shared/payments.ts", import.meta.url),
)
Deno.test("paymentNonRequotableReason blocks failed+debt", () => {
  assert(paymentsSrc.includes("status === \"failed\" && hasRecordedRefundDebt"))
})

const confirmSrc = await Deno.readTextFile(
  new URL("../migrations/202610290003_confirm_payment_refund_status.sql", import.meta.url),
)
Deno.test("confirm_payment records refund_reason on refund_required paths", () => {
  const count = (confirmSrc.match(/refund_reason = COALESCE\(refund_reason, '[^']+'\)/g) ?? []).length
  assert(count >= 3, `expected >=3, got ${count}`)
  assert(!confirmSrc.includes("refund_status = COALESCE(refund_status, 'requested')"))
})

const verifySrc = await Deno.readTextFile(
  new URL("../functions/verify-payment/index.ts", import.meta.url),
)
Deno.test("verify-payment issues refund on refund_required", () => {
  assert(verifySrc.includes("processRefundLocally"))
  assert(verifySrc.includes("refund_required"))
})

const reconcileSrc = await Deno.readTextFile(
  new URL("../functions/reconcile-payments/index.ts", import.meta.url),
)
Deno.test("reconcile retries failed payments with null refund_status but debt", () => {
  assert(reconcileSrc.includes("refund_status.is.null"))
  assert(reconcileSrc.includes("refund_reason.not.is.null"))
})
