// G-03: a stale refund claim must ask Razorpay before issuing a second refund.
// Run:
//   deno test --allow-read --allow-env --no-lock --node-modules-dir=none \
//     supabase/tests/refund_stale_reclaim.test.ts
//
// The claim mock mirrors claim_payment_refund (202610220004): a fresh claim
// conflicts, a stale claim is re-openable and reports stale_reclaimed, and the
// first claim persists refund_amount_due exactly once.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert"

Deno.env.set("RAZORPAY_KEY_ID", "rzp_test_id")
Deno.env.set("RAZORPAY_KEY_SECRET", "rzp_test_secret")

type ProviderRefund = { id: string; status: string; amount: number }

// --- mock Razorpay ---------------------------------------------------------
function makeProvider(
  opts: { existing?: ProviderRefund[]; listFails?: boolean; postFails?: boolean } = {},
) {
  const state = {
    posts: 0,
    gets: 0,
    refunds: [...(opts.existing ?? [])] as ProviderRefund[],
  }

  globalThis.fetch = (async (url: URL | RequestInfo | string, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? "GET").toUpperCase()

    if (method === "GET" && u.endsWith("/refunds")) {
      state.gets++
      if (opts.listFails) throw new Error("provider refund list unavailable")
      return new Response(JSON.stringify({ items: state.refunds }), { status: 200 })
    }

    if (method === "POST" && u.endsWith("/refund")) {
      state.posts++
      if (opts.postFails) throw new Error("provider refund failed")
      const body = JSON.parse(String(init?.body))
      const refund = { id: `ref_new_${state.posts}`, status: "processed", amount: body.amount }
      state.refunds.push(refund)
      return new Response(JSON.stringify(refund), { status: 200 })
    }

    throw new Error(`unexpected fetch: ${method} ${u}`)
  }) as typeof fetch

  return state
}

// --- mock payments row + claim machine ------------------------------------
function makeDb(
  init: {
    claimState?: "none" | "claimed" | "failed" | "issued"
    claimAgeMs?: number
    attempts?: number
  } = {},
) {
  const row = {
    id: "pay_1",
    razorpay_payment_id: "payid_1",
    status: "success",
    amount: 1000,
    refund_claim_state: init.claimState ?? "none",
    refund_claim_at: init.claimAgeMs != null ? Date.now() - init.claimAgeMs : null,
    refund_status: null as string | null,
    refund_attempt_count: init.attempts ?? 0,
    razorpay_refund_id: null as string | null,
    refunded_amount: null as number | null,
    refund_amount_due: null as number | null,
    refund_reason: null as string | null,
    walletDebits: 0,
    completions: [] as Array<Record<string, any>>,
  }

  const db = {
    row,
    async rpc(name: string, args: any) {
      if (name === "claim_payment_refund") {
        const wasClaimed = this.row.refund_claim_state === "claimed"

        // A live claim cannot be stolen; only a stale one is re-openable.
        if (
          wasClaimed &&
          this.row.refund_claim_at != null &&
          this.row.refund_claim_at > Date.now() - 15 * 60 * 1000
        ) {
          return { data: { conflict: true }, error: null }
        }

        this.row.refund_claim_state = "claimed"
        this.row.refund_claim_at = Date.now()
        this.row.refund_attempt_count += 1
        // COALESCE-once, exactly like the SQL.
        this.row.refund_reason = this.row.refund_reason ?? args.p_reason ?? null
        this.row.refund_amount_due = this.row.refund_amount_due ?? args.p_amount ?? null

        return {
          data: {
            ok: true,
            attempt: this.row.refund_attempt_count,
            stale_reclaimed: wasClaimed,
          },
          error: null,
        }
      }

      if (name === "complete_payment_refund") {
        this.row.completions.push(args)
        if (args.p_success) {
          this.row.status = "refunded"
          this.row.refund_status = args.p_status
          this.row.razorpay_refund_id = args.p_refund_id
          this.row.refund_claim_state = "issued"
          this.row.refunded_amount = args.p_amount
          this.row.refund_amount_due = null
          this.row.walletDebits += 1
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

// Dynamic import: _shared/refunds.ts reads required env at module load.
const importRefunds = () => import("../functions/_shared/refunds.ts")

Deno.test("stale claim recovers an existing provider refund without a second POST", async () => {
  const provider = makeProvider({
    existing: [{ id: "ref_A", status: "processed", amount: 1000 }],
  })
  const db = makeDb({ claimState: "claimed", claimAgeMs: 16 * 60 * 1000, attempts: 1 })
  const { attemptRefund } = await importRefunds()

  const out = await attemptRefund(
    { rpc: db.rpc.bind(db) } as any,
    db.row as any,
    1000,
    "event_cancellation",
  )

  assertEquals(out.status, "issued")
  assertEquals(out.recovered, true)
  assertEquals(out.refund_id, "ref_A")
  assertEquals(out.attempt, 2)
  assertEquals(provider.posts, 0, "must not issue a second provider refund")
  assertEquals(provider.gets, 1, "must consult the provider once before issuing")
  assertEquals(db.row.refund_claim_state, "issued")
  assertEquals(db.row.razorpay_refund_id, "ref_A")
  assertEquals(db.row.walletDebits, 1)
})

Deno.test("stale claim with no provider refund issues exactly one", async () => {
  const provider = makeProvider()
  const db = makeDb({ claimState: "claimed", claimAgeMs: 16 * 60 * 1000, attempts: 1 })
  const { attemptRefund } = await importRefunds()

  const out = await attemptRefund(
    { rpc: db.rpc.bind(db) } as any,
    db.row as any,
    1000,
    "event_cancellation",
  )

  assertEquals(out.status, "issued")
  assertEquals(out.recovered, undefined)
  assertEquals(provider.gets, 1)
  assertEquals(provider.posts, 1)
  assertEquals(db.row.walletDebits, 1)
})

Deno.test("a failed provider lookup sends nothing and releases the claim", async () => {
  const provider = makeProvider({ listFails: true })
  const db = makeDb({ claimState: "claimed", claimAgeMs: 16 * 60 * 1000, attempts: 1 })
  const { attemptRefund } = await importRefunds()

  await assertRejects(
    () =>
      attemptRefund(
        { rpc: db.rpc.bind(db) } as any,
        db.row as any,
        1000,
        "event_cancellation",
      ),
    Error,
    "provider refund list unavailable",
  )

  assertEquals(provider.posts, 0, "must never send money when the lookup fails")
  assertEquals(db.row.refund_claim_state, "failed")
  assertEquals(db.row.refund_status, "failed")
  assertEquals(db.row.walletDebits, 0)
})

Deno.test("a retry after a released claim also pre-checks the provider", async () => {
  // This is the case left behind when the catch's best-effort lookup failed:
  // the claim was released as failed while Razorpay already held the refund.
  const provider = makeProvider({
    existing: [{ id: "ref_B", status: "pending", amount: 1000 }],
  })
  const db = makeDb({ claimState: "failed", attempts: 1 })
  const { attemptRefund } = await importRefunds()

  const out = await attemptRefund(
    { rpc: db.rpc.bind(db) } as any,
    db.row as any,
    1000,
    "event_cancellation",
  )

  assertEquals(out.status, "issued")
  assertEquals(out.recovered, true)
  assertEquals(out.refund_id, "ref_B")
  assertEquals(out.refund_status, "pending")
  assertEquals(provider.posts, 0)
  assertEquals(provider.gets, 1)
  assertEquals(db.row.refund_claim_state, "issued")
  assertEquals(db.row.walletDebits, 1)
})

Deno.test("a first refund does not pay for a provider pre-check", async () => {
  const provider = makeProvider()
  const db = makeDb()
  const { attemptRefund } = await importRefunds()

  const out = await attemptRefund(
    { rpc: db.rpc.bind(db) } as any,
    db.row as any,
    1000,
    "event_cancellation",
  )

  assertEquals(out.status, "issued")
  assertEquals(provider.gets, 0, "first attempt keeps its current latency")
  assertEquals(provider.posts, 1)
})

Deno.test("failed, cancelled and reversed refunds are not treated as live", async () => {
  const { firstExistingRefund } = await importRefunds()

  for (const status of ["failed", "cancelled", "reversed"]) {
    makeProvider({ existing: [{ id: `ref_${status}`, status, amount: 1000 }] })
    assert(
      (await firstExistingRefund({}, "payid_1")) === null,
      `${status} refund must not count as an issued refund`,
    )
  }

  makeProvider({ existing: [{ id: "ref_ok", status: "processed", amount: 1000 }] })
  const found = await firstExistingRefund({}, "payid_1")
  assertEquals(found?.id, "ref_ok")
})

Deno.test("a rejected POST with only a failed provider refund is released, not issued", async () => {
  const provider = makeProvider({
    existing: [{ id: "ref_failed", status: "failed", amount: 1000 }],
    postFails: true,
  })
  const db = makeDb()
  const { attemptRefund } = await importRefunds()

  await assertRejects(
    () =>
      attemptRefund(
        { rpc: db.rpc.bind(db) } as any,
        db.row as any,
        1000,
        "event_cancellation",
      ),
    Error,
    "provider refund failed",
  )

  assertEquals(provider.posts, 1)
  assertEquals(
    db.row.completions.filter((c) => c.p_success).length,
    0,
    "a failed provider refund must not be recorded as issued",
  )
  assertEquals(db.row.refund_claim_state, "failed")
  assertEquals(db.row.walletDebits, 0)
})
