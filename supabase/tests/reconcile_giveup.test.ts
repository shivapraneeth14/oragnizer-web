// G-01: pending payments are only given up on when Razorpay proves no money
// was captured. Run:
//   deno test --allow-read --allow-env --no-lock --node-modules-dir=none \
//     supabase/tests/reconcile_giveup.test.ts
//
// The resolver is dependency-injected, so the provider call order and the
// guarded write can be asserted without booting Deno.serve or a live database.

import { assert, assertEquals } from "jsr:@std/assert"
import {
  decidePendingPayment,
  PENDING_GIVE_UP_AFTER_MS,
  resolvePendingPayment,
  type PendingDeps,
  type PendingPaymentRow,
} from "../functions/_shared/reconcile-pending.ts"

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000

function row(overrides: Partial<PendingPaymentRow> = {}): PendingPaymentRow {
  return {
    id: "pay_1",
    razorpay_order_id: "order_1",
    registration_id: "reg_1",
    coupon_id: null,
    created_at: new Date(NOW - 3 * HOUR).toISOString(),
    ...overrides,
  }
}

interface HarnessOptions {
  order?: { status?: string; amount_paid?: number } | Error
  payments?: Array<{ id: string; status?: string; amount?: number }> | Error
  confirm?: { action?: string; error?: string; skipped?: boolean }
  expiryWins?: boolean
}

function harness(opts: HarnessOptions = {}) {
  const calls: string[] = []
  const writes: string[] = []

  const deps: PendingDeps = {
    getOrder: () => {
      calls.push("getOrder")
      if (opts.order instanceof Error) return Promise.reject(opts.order)
      return Promise.resolve(opts.order ?? { status: "created", amount_paid: 0 })
    },
    listOrderPayments: () => {
      calls.push("listOrderPayments")
      if (opts.payments instanceof Error) return Promise.reject(opts.payments)
      return Promise.resolve(opts.payments ?? [])
    },
    setCapturedPaymentId: () => {
      calls.push("setCapturedPaymentId")
      writes.push("captured_payment_id")
      return Promise.resolve()
    },
    confirmPayment: () => {
      calls.push("confirmPayment")
      return Promise.resolve(opts.confirm ?? { action: "confirmed" })
    },
    markExpired: () => {
      calls.push("markExpired")
      const won = opts.expiryWins ?? true
      if (won) writes.push("payment_failed")
      return Promise.resolve(won)
    },
    cancelRegistration: () => {
      calls.push("cancelRegistration")
      writes.push("registration_cancelled")
      return Promise.resolve()
    },
    releaseCoupon: () => {
      calls.push("releaseCoupon")
      writes.push("coupon_released")
      return Promise.resolve()
    },
    audit: (action: string) => {
      calls.push(`audit:${action}`)
      writes.push(action)
      return Promise.resolve()
    },
    now: () => NOW,
  }

  return { deps, calls, writes }
}

// --- pure decision table ---------------------------------------------------

Deno.test("paid + captured is confirmed at any age", () => {
  assertEquals(
    decidePendingPayment({
      orderStatus: "paid",
      amountPaid: 1000,
      hasCapturedPayment: true,
      ageMs: 10 * HOUR,
    }),
    { action: "confirm" },
  )
})

Deno.test("paid without a visible capture is sent to manual review, never expired", () => {
  assertEquals(
    decidePendingPayment({
      orderStatus: "paid",
      amountPaid: 1000,
      hasCapturedPayment: false,
      ageMs: 10 * HOUR,
    }),
    { action: "manual", reason: "paid_without_captured_payment" },
  )
})

Deno.test("unpaid inside the window waits", () => {
  assertEquals(
    decidePendingPayment({
      orderStatus: "created",
      amountPaid: 0,
      hasCapturedPayment: false,
      ageMs: PENDING_GIVE_UP_AFTER_MS - 1,
    }),
    { action: "wait" },
  )
})

Deno.test("unpaid at the 2h boundary expires", () => {
  assertEquals(
    decidePendingPayment({
      orderStatus: "attempted",
      amountPaid: 0,
      hasCapturedPayment: false,
      ageMs: PENDING_GIVE_UP_AFTER_MS,
    }),
    { action: "expire" },
  )
})

// --- resolver behaviour ----------------------------------------------------

Deno.test("a paid capture confirms and never writes a failure", async () => {
  const h = harness({
    order: { status: "paid", amount_paid: 1000 },
    payments: [{ id: "pay_captured", status: "captured", amount: 1000 }],
  })

  const out = await resolvePendingPayment(row(), h.deps)

  assertEquals(out.action, "confirmed")
  assertEquals(h.calls, ["getOrder", "listOrderPayments", "setCapturedPaymentId", "confirmPayment"])
  assertEquals(h.writes, ["captured_payment_id"], "no terminal failure write may happen")
})

Deno.test("a paid order with no captured payment is never cancelled", async () => {
  const h = harness({
    order: { status: "paid", amount_paid: 1000 },
    payments: [],
  })

  const out = await resolvePendingPayment(row(), h.deps)

  assertEquals(out.action, "manual")
  assertEquals(h.writes, [])
  assert(!h.calls.includes("markExpired"))
})

Deno.test("an unpaid 3h payment is expired only after the provider check", async () => {
  const h = harness({ order: { status: "created", amount_paid: 0 } })

  const out = await resolvePendingPayment(row({ coupon_id: "coupon_1" }), h.deps)

  assertEquals(out.action, "expired")
  assertEquals(h.calls, [
    "getOrder",
    "markExpired",
    "cancelRegistration",
    "releaseCoupon",
    "audit:payment_reconcile_gave_up",
  ])
  assertEquals(h.writes, [
    "payment_failed",
    "registration_cancelled",
    "coupon_released",
    "payment_reconcile_gave_up",
  ])
})

Deno.test("an unpaid 30m payment waits without writing anything", async () => {
  const h = harness({ order: { status: "created", amount_paid: 0 } })

  const out = await resolvePendingPayment(
    row({ created_at: new Date(NOW - 30 * 60 * 1000).toISOString() }),
    h.deps,
  )

  assertEquals(out.action, "wait")
  assertEquals(h.writes, [])
})

Deno.test("losing the guarded expiry race leaves the registration alone", async () => {
  const h = harness({ order: { status: "created", amount_paid: 0 }, expiryWins: false })

  const out = await resolvePendingPayment(row(), h.deps)

  assertEquals(out, { action: "wait", reason: "race_lost" })
  assertEquals(h.calls, ["getOrder", "markExpired"])
  assertEquals(h.writes, [])
})

Deno.test("a provider lookup failure writes nothing", async () => {
  const h = harness({ order: new Error("razorpay unreachable") })

  const out = await resolvePendingPayment(row(), h.deps)

  assertEquals(out, { action: "wait", reason: "razorpay unreachable" })
  assertEquals(h.writes, [])
})

Deno.test("a paid order with a failing payments lookup is never expired", async () => {
  const h = harness({
    order: { status: "paid", amount_paid: 1000 },
    payments: new Error("provider list lag"),
  })

  const out = await resolvePendingPayment(row(), h.deps)

  assertEquals(out, { action: "wait", reason: "provider list lag" })
  assertEquals(h.writes, [])
  assert(!h.calls.includes("markExpired"))
})

Deno.test("a confirm_payment error is manual review, not a cancellation", async () => {
  const h = harness({
    order: { status: "paid", amount_paid: 1000 },
    payments: [{ id: "pay_captured", status: "captured", amount: 1000 }],
    confirm: { error: "confirm blew up" },
  })

  const out = await resolvePendingPayment(row(), h.deps)

  assertEquals(out, { action: "manual", reason: "confirm_failed", error: "confirm blew up" })
  assert(!h.calls.includes("markExpired"))
  assert(!h.writes.includes("registration_cancelled"))
})

Deno.test("refund_required returns the captured amount for the refund flow", async () => {
  const h = harness({
    order: { status: "paid", amount_paid: 1000 },
    payments: [{ id: "pay_captured", status: "captured", amount: 1000 }],
    confirm: { action: "refund_required" },
  })

  const out = await resolvePendingPayment(row(), h.deps)

  assertEquals(out, { action: "refund_required", paymentId: "pay_1", amount: 1000 })
})

Deno.test("a payment already confirmed by a webhook is left alone", async () => {
  const h = harness({
    order: { status: "paid", amount_paid: 1000 },
    payments: [{ id: "pay_captured", status: "captured", amount: 1000 }],
    confirm: { skipped: true },
  })

  const out = await resolvePendingPayment(row(), h.deps)

  assertEquals(out.action, "already_confirmed")
  assert(!h.calls.includes("markExpired"))
})

// --- regression tripwires on the job source --------------------------------

const src = await Deno.readTextFile(
  new URL("../functions/reconcile-payments/index.ts", import.meta.url),
)

Deno.test("the old blind >2h give-up window is gone", () => {
  assert(
    !src.includes("2 * 60 * 60 * 1000"),
    "the pending path must not keep a separate age-only give-up window",
  )
  assert(src.includes("resolvePendingPayment(pay, pendingDeps)"))
})

Deno.test("expiring a payment is guarded on it still being pending", () => {
  const start = src.indexOf("markExpired: async")
  assert(start >= 0, "markExpired dependency not found")
  const block = src.slice(start, start + 900)
  assert(block.includes('.eq("status", "pending")'))
})

Deno.test("refund exhaustion is recorded from the sweep, the in-flight sync and the catch", () => {
  const calls = src.match(/flagExhausted\(/g) ?? []
  assert(calls.length >= 3, `expected at least 3 flagExhausted call sites, found ${calls.length}`)
  assert(src.includes("flagExhaustedRefunds()"))
})

Deno.test("a reversed provider refund is treated as dead", async () => {
  assert(src.includes("isProviderRefundDead(refund?.status)"))
  const helper = await Deno.readTextFile(
    new URL("../functions/_shared/refund-retry.ts", import.meta.url),
  )
  assert(helper.includes('"reversed"'))
})
