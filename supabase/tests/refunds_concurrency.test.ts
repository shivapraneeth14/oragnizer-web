// A1: exactly-once refund claim contract.
// Run: deno test supabase/tests/refunds_concurrency.test.ts
// (Requires Deno; the repo build pipeline runs this in CI. Locally the
// contracts used to hold are verified statically and marked
// UNVERIFIED-PENDING-DEPLOY — mocked provider behaviour cannot be proven on a
// machine without Deno or a real Razorpay sandbox.)

import { assert, assertEquals } from "jsr:@std/assert"

Deno.env.set("RAZORPAY_KEY_ID", "rzp_test_id")
Deno.env.set("RAZORPAY_KEY_SECRET", "rzp_test_secret")
Deno.env.set("SUPABASE_URL", "https://example.supabase.co")
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "svc_key")

// --- mock Razorpay provider ------------------------------------------------
function makeProvider() {
  let calls = 0
  const refunds: Array<{ id: string; status: string; amount: number }> = []
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? "GET").toUpperCase()
    if (method === "POST" && u.endsWith("/refund")) {
      calls++
      // Simulate provider processing: two identical refund calls would both
      // succeed against a naive mock, but a real provider (or the claim) must
      // only observe one.
      const body = JSON.parse(String(init?.body))
      const refund = { id: `ref_${calls}`, status: "processed", amount: body.amount }
      refunds.push(refund)
      return new Response(JSON.stringify(refund), { status: 200 })
    }
    if (u.endsWith("/refunds") && method === "GET") {
      return new Response(JSON.stringify({ items: refunds }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${method} ${u}`)
  }
  return { calls, refunds }
}

// --- in-memory payments mimicking the DB + RPC claim state machine --------
function makeDb() {
  const row = {
    id: "pay_1",
    razorpay_payment_id: "payid_1",
    status: "success",
    refund_claim_state: "none",
    refund_claim_at: null,
    refund_status: null,
    refund_attempt_count: 0,
    razorpay_refund_id: null,
    amount: 1000,
  }
  const db = {
    row,
    claimCalls: 0,
    async rpc(name: string, args: any) {
      if (name === "claim_payment_refund") {
        // emulate SELECT ... FOR UPDATE serialization
        if (this.row.refund_claim_state === "claimed") {
          const fresh = this.row.refund_claim_at > Date.now() - 15 * 60 * 1000
          if (fresh) return { data: { conflict: true }, error: null }
        }
        this.row.refund_claim_state = "claimed"
        this.row.refund_claim_at = Date.now()
        this.row.refund_attempt_count += 1
        return { data: { ok: true, attempt: this.row.refund_attempt_count, stale_reclaimed: false }, error: null }
      }
      if (name === "complete_payment_refund") {
        const { p_success } = args
        if (p_success) {
          this.row.status = "refunded"
          this.row.refund_status = args.p_status
          this.row.razorpay_refund_id = args.p_refund_id
          this.row.refund_claim_state = "issued"
          this.row.walletDebits = (this.row.walletDebits ?? 0) + 1
        } else {
          this.row.refund_claim_state = "failed"
          this.row.refund_status = "failed"
        }
        return { data: { ok: true }, error: null }
      }
      throw new Error(`unexpected rpc ${name}`)
    },
  }
  return db
}

Deno.test("two concurrent refund attempts produce exactly one provider call", async () => {
  const provider = makeProvider()
  const db = makeDb()
  const supabase = {
    rpc: (n: string, a: any) => db.rpc(n, a),
  }

  const { attemptRefund } = await import("../functions/_shared/refunds.ts")
  const [o1, o2] = await Promise.all([
    attemptRefund(supabase as any, db.row as any, 1000, "test_reason"),
    attemptRefund(supabase as any, db.row as any, 1000, "test_reason"),
  ])

  assertEquals(provider.calls, 1, "exactly one provider refund call")
  const issued = [o1, o2].filter((o) => o.status === "issued")
  const conflicted = [o1, o2].filter((o) => o.status === "conflict")
  assertEquals(issued.length, 1, "exactly one winner")
  assertEquals(conflicted.length, 1, "loser gets conflict")
})

Deno.test("crash between claim and provider call leaves a recoverable state", async () => {
  // Provider is down -> first attempt throws after releasing the claim.
  const db = makeDb()
  globalThis.fetch = async () => {
    throw new Error("provider unreachable")
  }
  const supabase = { rpc: (n: string, a: any) => db.rpc(n, a) }

  const { attemptRefund } = await import("../functions/_shared/refunds.ts")

  const first = await attemptRefund(supabase as any, db.row as any, 1000, "test_reason")
    .then(() => "issued")
    .catch(() => "failed")

  assertEquals(first, "failed")
  // Claim released as 'failed' so a retry may re-claim.
  assertEquals(db.row.refund_claim_state, "failed")
  assertEquals(db.row.refund_status, "failed")
})