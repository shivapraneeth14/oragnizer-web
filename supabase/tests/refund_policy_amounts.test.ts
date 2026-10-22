// P3: refund policy integrity — organizer vs customer amounts, retries, and
// the webhook/reconcile paths. Run:
//   deno test --allow-env supabase/tests/refund_policy_amounts.test.ts
//
// The rule (one place, all call sites/retries):
//   organizer-cancelled -> FULL amount incl. platform fee
//   customer-cancelled  -> amount MINUS the persisted platform fee
// Persistence (refund_reason/refund_amount_due written once by
// claim_payment_refund, never overwritten) is enforced by migration
// 202610220004; here the claim mock mirrors its COALESCE-once semantics.

import { assert, assertEquals } from "jsr:@std/assert"

Deno.env.set("RAZORPAY_KEY_ID", "rzp_test_id")
Deno.env.set("RAZORPAY_KEY_SECRET", "rzp_test_secret")
Deno.env.set("SUPABASE_URL", "https://example.supabase.co")
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "svc_key")

// Ticket 10000 + platform fee 1000 = customer paid 11000.
const AMOUNT = 11000
const FEE = 1000
const OWED = 10000

function makeProvider(opts: { failIssues?: number } = {}) {
  const state = {
    issued: 0,
    failed: 0,
    bodies: [] as Array<{ amount: number; receipt?: string }>,
  }
  const refunds: Array<{ id: string; status: string; amount: number }> = []
  globalThis.fetch = (async (url: URL | RequestInfo | string, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? "GET").toUpperCase()
    if (method === "POST" && u.endsWith("/refund")) {
      const body = JSON.parse(String(init?.body))
      state.bodies.push(body)
      if (state.failed < (opts.failIssues ?? 0)) {
        state.failed++
        throw new Error("provider unreachable") // request may still have landed
      }
      state.issued++
      const refund = { id: `ref_${state.issued}`, status: "processed", amount: body.amount }
      refunds.push(refund)
      return new Response(JSON.stringify(refund), { status: 200 })
    }
    if (method === "GET" && u.endsWith("/refunds")) {
      return new Response(JSON.stringify({ items: refunds }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${method} ${u}`)
  }) as typeof fetch
  return state
}

function makeDb(init: { refund_reason?: string | null; refund_amount_due?: number | null } = {}) {
  const row = {
    id: "pay_1",
    razorpay_payment_id: "payid_1",
    status: "success",
    amount: AMOUNT,
    platform_fee: FEE,
    refund_claim_state: "none",
    refund_claim_at: null as number | null,
    refund_status: null as string | null,
    refund_attempt_count: 0,
    razorpay_refund_id: null as string | null,
    refunded_amount: null as number | null,
    refund_reason: init.refund_reason ?? null,
    refund_amount_due: init.refund_amount_due ?? null,
    walletDebits: 0,
  }
  const db = {
    row,
    async rpc(name: string, args: any) {
      if (name === "claim_payment_refund") {
        if (this.row.refund_claim_state === "claimed") {
          const fresh = (this.row.refund_claim_at ?? 0) > Date.now() - 15 * 60 * 1000
          if (fresh) return { data: { conflict: true }, error: null }
        }
        this.row.refund_claim_state = "claimed"
        this.row.refund_claim_at = Date.now()
        this.row.refund_attempt_count += 1
        // COALESCE-once, exactly like migration 202610220004: the first claim
        // persists the policy inputs; stale reclaims/retries never flip them.
        this.row.refund_reason = this.row.refund_reason ?? args.p_reason ?? null
        this.row.refund_amount_due = this.row.refund_amount_due ?? args.p_amount ?? null
        return { data: { ok: true, attempt: this.row.refund_attempt_count, stale_reclaimed: false }, error: null }
      }
      if (name === "complete_payment_refund") {
        if (args.p_success) {
          this.row.status = "refunded"
          this.row.refund_status = args.p_status
          this.row.razorpay_refund_id = args.p_refund_id
          this.row.refund_claim_state = "issued"
          this.row.refunded_amount = args.p_amount
          this.row.refund_amount_due = null // settled — retries must not re-derive
          this.row.walletDebits += 1
        } else {
          this.row.refund_claim_state = "failed"
          this.row.refund_status = "failed"
          // refund_amount_due/refund_reason are KEPT for the retry.
        }
        return { data: { ok: true }, error: null }
      }
      throw new Error(`unexpected rpc ${name}`)
    },
  }
  return db
}

// Dynamic import: _shared/refunds.ts reads required env at module load, which
// must happen AFTER the Deno.env.set calls above.
const importAttempt = () => import("../functions/_shared/refunds.ts")

Deno.test("policy mapping: only customer self-cancel excludes the fee", async () => {
  const { refundPolicyForReason, customerOwedAmount } = await importAttempt()
  assertEquals(refundPolicyForReason("registration_cancellation"), "customer")
  for (const r of ["event_cancellation", "organizer_issue_refund", "capacity_full", "event_cancelled", "registration_cancelled", null]) {
    assertEquals(refundPolicyForReason(r), "organizer", `${r} -> full refund`)
  }
  assertEquals(customerOwedAmount({ amount: AMOUNT, platform_fee: FEE }), OWED)
})

Deno.test("organizer cancellation refunds the FULL amount including the fee", async () => {
  const provider = makeProvider()
  const db = makeDb()
  const { attemptRefund, refundPolicyForReason, refundAmountForPolicy } = await importAttempt()

  const policy = refundPolicyForReason("event_cancellation")
  const amount = refundAmountForPolicy(policy, db.row)
  assertEquals(amount, AMOUNT, "full amount, fee included")

  const out = await attemptRefund({ rpc: db.rpc.bind(db) } as any, db.row as any, amount, "event_cancellation")
  assertEquals(out.status, "issued")
  assertEquals(provider.bodies[0].amount, AMOUNT, "provider refunded the full 11000")
  assertEquals(db.row.refunded_amount, AMOUNT)
  assertEquals(db.row.refund_amount_due, null, "settled due cleared")
})

Deno.test("customer self-cancel refunds amount MINUS the platform fee", async () => {
  const provider = makeProvider()
  const db = makeDb()
  const { attemptRefund, refundPolicyForReason, refundAmountForPolicy } = await importAttempt()

  const policy = refundPolicyForReason("registration_cancellation")
  const amount = refundAmountForPolicy(policy, db.row)
  assertEquals(amount, OWED, "ticket only, fee kept")

  const out = await attemptRefund({ rpc: db.rpc.bind(db) } as any, db.row as any, amount, "registration_cancellation")
  assertEquals(out.status, "issued")
  assertEquals(provider.bodies[0].amount, OWED, "provider refunded 10000, never 11000")
  assertEquals(db.row.refunded_amount, OWED)
  assertEquals(db.row.refund_reason, "registration_cancellation")
  assertEquals(db.row.refund_amount_due, null)
})

Deno.test("webhook auto-refund on a cancelled capture is FULL (organizer policy)", async () => {
  const { refundPolicyForReason, refundAmountForPolicy } = await importAttempt()
  for (const reason of ["registration_cancelled", "capacity_full", "event_cancelled"]) {
    const policy = refundPolicyForReason(reason)
    assertEquals(refundAmountForPolicy(policy, { amount: AMOUNT, platform_fee: FEE }), AMOUNT)
  }
})

Deno.test("a failed customer refund retries EXACTLY the owed amount (no fee leak)", async () => {
  const provider = makeProvider({ failIssues: 1 })
  const db = makeDb()
  const { attemptRefund, refundRetryPlan } = await importAttempt()
  const supabase = { rpc: db.rpc.bind(db) }

  const first = await attemptRefund(supabase as any, db.row as any, OWED, "registration_cancellation")
    .then(() => "issued").catch(() => "failed")
  assertEquals(first, "failed")
  assertEquals(db.row.refund_claim_state, "failed")
  assertEquals(db.row.refund_amount_due, OWED, "owed survives the failure")
  assertEquals(db.row.refund_reason, "registration_cancellation")

  // Reconcile's path: use the persisted plan — never re-derive from amount.
  const plan = refundRetryPlan(db.row)
  assertEquals(plan, { amount: OWED, reason: "registration_cancellation" })

  const retry = await attemptRefund(supabase as any, db.row as any, plan.amount, plan.reason)
  assertEquals(retry.status, "issued")
  assertEquals(provider.bodies.map((b) => b.amount), [OWED, OWED], "retry never escalates to the full amount")
  assertEquals(db.row.refunded_amount, OWED)
  assertEquals(db.row.walletDebits, 1, "one settlement")
})

Deno.test("claim persistence is COALESCE-once: a later claim cannot flip reason/due", async () => {
  const db = makeDb()
  const supabase = { rpc: db.rpc.bind(db) }
  await supabase.rpc("claim_payment_refund", {
    p_payment_id: "pay_1",
    p_reason: "registration_cancellation",
    p_amount: OWED,
  })
  db.row.refund_claim_state = "failed" // released, retry may re-claim
  db.row.refund_status = "failed"
  await supabase.rpc("claim_payment_refund", {
    p_payment_id: "pay_1",
    p_reason: "event_cancellation",
    p_amount: AMOUNT,
  })
  assertEquals(db.row.refund_reason, "registration_cancellation", "reason immutable after first claim")
  assertEquals(db.row.refund_amount_due, OWED, "owed amount immutable after first claim")
})

Deno.test("a failed customer refund retries the persisted policy, not a re-derivation", async () => {
  const provider = makeProvider({ failIssues: 1 })
  const db = makeDb({ refund_reason: "registration_cancellation", refund_amount_due: OWED })
  const { attemptRefund, refundRetryPlan } = await importAttempt()
  const supabase = { rpc: db.rpc.bind(db) }

  await attemptRefund(supabase as any, db.row as any, OWED, "registration_cancellation").catch(() => {})
  const plan = refundRetryPlan(db.row)
  assertEquals(plan, { amount: OWED, reason: "registration_cancellation" })

  const retry = await attemptRefund(supabase as any, db.row as any, plan.amount, plan.reason)
  assertEquals(retry.status, "issued")
  assertEquals(provider.bodies.map((b) => b.amount), [OWED, OWED], "never escalates to full 11000")
  assertEquals(db.row.refund_reason, "registration_cancellation")
})

Deno.test("organizer refund retries the full amount", async () => {
  const provider = makeProvider({ failIssues: 1 })
  const db = makeDb()
  const { attemptRefund, refundRetryPlan } = await importAttempt()
  const supabase = { rpc: db.rpc.bind(db) }

  await attemptRefund(supabase as any, db.row as any, AMOUNT, "event_cancellation").catch(() => {})
  const plan = refundRetryPlan(db.row)
  assertEquals(plan, { amount: AMOUNT, reason: "event_cancellation" })
  const retry = await attemptRefund(supabase as any, db.row as any, plan.amount, plan.reason)
  assertEquals(retry.status, "issued")
  assertEquals(provider.bodies.map((b) => b.amount), [AMOUNT, AMOUNT])
})

Deno.test("concurrent retries after a failure still refund exactly once", async () => {
  const provider = makeProvider({ failIssues: 1 })
  const db = makeDb()
  const { attemptRefund, refundRetryPlan } = await importAttempt()
  const supabase = { rpc: db.rpc.bind(db) }

  await attemptRefund(supabase as any, db.row as any, OWED, "registration_cancellation").catch(() => {})
  const plan = refundRetryPlan(db.row)

  const outcomes = await Promise.all([
    attemptRefund(supabase as any, db.row as any, plan.amount, plan.reason),
    attemptRefund(supabase as any, db.row as any, plan.amount, plan.reason),
  ])
  assertEquals(outcomes.filter((o) => o.status === "issued").length, 1)
  assertEquals(outcomes.filter((o) => o.status === "conflict").length, 1)
  assertEquals(provider.issued, 1, "one successful provider refund")
  assertEquals(db.row.refunded_amount, OWED)
})

Deno.test("legacy failed row (no persisted due) keeps the historical fallback", async () => {
  const { refundRetryPlan } = await importAttempt()
  assertEquals(refundRetryPlan({ amount: AMOUNT, refunded_amount: null, refund_amount_due: null, refund_reason: null }), {
    amount: AMOUNT,
    reason: "reconcile_refund_retry",
  })
  assertEquals(refundRetryPlan({ amount: AMOUNT, refunded_amount: OWED, refund_amount_due: null }), {
    amount: OWED,
    reason: "reconcile_refund_retry",
  })
})
