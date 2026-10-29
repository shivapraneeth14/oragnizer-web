// G-01: refund retries stop at the cap, but the stop must be recorded on every
// path and must be visible per payment. Run:
//   deno test --allow-read --allow-env --no-lock --node-modules-dir=none \
//     supabase/tests/refund_exhaustion.test.ts

import { assert, assertEquals } from "jsr:@std/assert"
import {
  EXHAUSTED_NOTE,
  flagRefundExhausted,
  isProviderRefundDead,
  nextRefundAttempt,
  refundPendingTooLong,
  shouldFlagExhausted,
  type ExhaustionDeps,
} from "../functions/_shared/refund-retry.ts"
import { recordAlert } from "../functions/_shared/alerts.ts"

const HOUR = 60 * 60 * 1000
const NOW = 1_800_000_000_000

// --- pure helpers ----------------------------------------------------------

Deno.test("attempts advance by exactly one", () => {
  assertEquals(nextRefundAttempt(null), 1)
  assertEquals(nextRefundAttempt(undefined), 1)
  assertEquals(nextRefundAttempt(4), 5)
})

Deno.test("failed, cancelled and reversed provider refunds are dead", () => {
  for (const status of ["failed", "cancelled", "reversed"]) {
    assert(isProviderRefundDead(status), `${status} must be dead`)
  }
  for (const status of ["processed", "pending", "queued", "created", "initiated", undefined]) {
    assert(!isProviderRefundDead(status), `${status} must not be dead`)
  }
})

Deno.test("only stuck refunds at the cap are flagged", () => {
  assertEquals(
    shouldFlagExhausted({ id: "p", refund_attempt_count: 4, refund_status: "failed" }),
    false,
  )
  assertEquals(
    shouldFlagExhausted({ id: "p", refund_attempt_count: 5, refund_status: "failed" }),
    true,
  )
  // Accepted by the provider: in flight, not exhausted.
  assertEquals(
    shouldFlagExhausted({
      id: "p",
      refund_attempt_count: 5,
      refund_status: "pending",
      razorpay_refund_id: "rfnd_1",
    }),
    false,
  )
  // Pending without a provider id: stuck.
  assertEquals(
    shouldFlagExhausted({
      id: "p",
      refund_attempt_count: 5,
      refund_status: "pending",
      razorpay_refund_id: null,
    }),
    true,
  )
})

Deno.test("a refund still pending after 24h is escalated", () => {
  const old = new Date(NOW - 25 * HOUR).toISOString()
  const fresh = new Date(NOW - 23 * HOUR).toISOString()
  assertEquals(refundPendingTooLong(old, NOW), true)
  assertEquals(refundPendingTooLong(fresh, NOW), false)
  assertEquals(refundPendingTooLong(null, NOW), false)
  assertEquals(refundPendingTooLong("not-a-date", NOW), false)
})

// --- exhaustion writer -----------------------------------------------------

function makeHarness(opts: { hasAudit?: boolean; insertOk?: boolean } = {}) {
  const audits: Array<{ id: string; attempts: number; note: string }> = []
  const alerts: Array<{ id: string; attempts: number; note: string }> = []

  const deps: ExhaustionDeps = {
    hasAudit: () => Promise.resolve(opts.hasAudit ?? false),
    insertAudit: (paymentId, attempts, note) => {
      if (opts.insertOk === false) return Promise.resolve(false)
      audits.push({ id: paymentId, attempts, note })
      return Promise.resolve(true)
    },
    alert: (paymentId, attempts, note) => {
      alerts.push({ id: paymentId, attempts, note })
      return Promise.resolve()
    },
  }

  return { deps, audits, alerts }
}

Deno.test("the first exhaustion records an audit row and one alert", async () => {
  const h = makeHarness()

  const wrote = await flagRefundExhausted({ paymentId: "pay_1", attempts: 5 }, h.deps)

  assertEquals(wrote, true)
  assertEquals(h.audits.length, 1)
  assertEquals(h.audits[0].note, EXHAUSTED_NOTE)
  assertEquals(h.alerts.length, 1)
  assertEquals(h.alerts[0].id, "pay_1")
})

Deno.test("an existing audit row suppresses the write and the alert", async () => {
  const h = makeHarness({ hasAudit: true })

  const wrote = await flagRefundExhausted({ paymentId: "pay_1", attempts: 5 }, h.deps)

  assertEquals(wrote, false)
  assertEquals(h.audits, [])
  assertEquals(h.alerts, [])
})

Deno.test("a failed audit insert does not alert", async () => {
  const h = makeHarness({ insertOk: false })

  const wrote = await flagRefundExhausted({ paymentId: "pay_1", attempts: 5 }, h.deps)

  assertEquals(wrote, false)
  assertEquals(h.alerts, [])
})

Deno.test("a custom note is preserved for permanent preconditions", async () => {
  const h = makeHarness()

  await flagRefundExhausted(
    { paymentId: "pay_1", attempts: 0, note: "Unable to start a refund: no razorpay_payment_id" },
    h.deps,
  )

  assertEquals(h.audits[0].note, "Unable to start a refund: no razorpay_payment_id")
  assertEquals(h.alerts[0].note, "Unable to start a refund: no razorpay_payment_id")
})

Deno.test("calling twice for the same payment writes once", async () => {
  const seen = new Set<string>()
  const audits: string[] = []
  const alerts: string[] = []
  const deps: ExhaustionDeps = {
    hasAudit: (id) => Promise.resolve(seen.has(id)),
    insertAudit: (id) => {
      seen.add(id)
      audits.push(id)
      return Promise.resolve(true)
    },
    alert: (id) => {
      alerts.push(id)
      return Promise.resolve()
    },
  }

  assertEquals(await flagRefundExhausted({ paymentId: "pay_1", attempts: 5 }, deps), true)
  assertEquals(await flagRefundExhausted({ paymentId: "pay_1", attempts: 5 }, deps), false)

  assertEquals(audits, ["pay_1"])
  assertEquals(alerts, ["pay_1"])
})

// --- per-payment alert dedupe ---------------------------------------------

function mockAlertsClient(existing: unknown[] = []) {
  const filters: Array<[string, unknown]> = []
  const inserted: Array<Record<string, unknown>> = []

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push([column, value])
      return builder
    },
    in: () => builder,
    gte: () => builder,
    limit: () => Promise.resolve({ data: existing, error: null }),
    insert: (row: Record<string, unknown>) => {
      inserted.push(row)
      return Promise.resolve({ error: null })
    },
  }

  return { client: { from: () => builder }, filters, inserted }
}

Deno.test("a dedupeKey scopes the alert to one payment instead of the title", async () => {
  const mock = mockAlertsClient()

  await recordAlert(mock.client as never, {
    severity: "warning",
    category: "payment",
    title: "Refund retry failed for payment",
    dedupeKey: "refund_retry_failed:pay_1",
    details: { payment_id: "pay_1" },
  })

  assert(
    mock.filters.some(([column, value]) =>
      column === "details->>dedupe_key" && value === "refund_retry_failed:pay_1"
    ),
    "dedupe must be scoped by dedupeKey",
  )
  assertEquals(mock.inserted.length, 1)
  assertEquals(
    (mock.inserted[0].details as Record<string, unknown>).dedupe_key,
    "refund_retry_failed:pay_1",
  )
})

Deno.test("without a dedupeKey the old title-wide behaviour is unchanged", async () => {
  const mock = mockAlertsClient()

  await recordAlert(mock.client as never, {
    severity: "warning",
    category: "payment",
    title: "Payment confirmed by reconcile — webhook delivery missed",
    details: { payment_id: "pay_1" },
  })

  assert(
    !mock.filters.some(([column]) => column === "details->>dedupe_key"),
    "no dedupeKey means title-wide dedupe",
  )
  assertEquals(mock.inserted[0].details, { payment_id: "pay_1" })
})
