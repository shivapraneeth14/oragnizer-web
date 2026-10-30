import { assert, assertEquals, assertRejects } from "jsr:@std/assert"
import {
  razorpayGet,
  razorpayPost,
  razorpayRequest,
  RazorpayClientError,
  RazorpayRateLimitError,
  RazorpayServerError,
  RazorpayTimeoutError,
  RazorpayUncertainOutcomeError,
} from "../functions/_shared/razorpay.ts"

// Setup test credentials
Deno.env.set("RAZORPAY_KEY_ID", "rzp_test_key_123")
Deno.env.set("RAZORPAY_KEY_SECRET", "rzp_test_secret_456")

Deno.test("razorpayGet attaches correct Basic Auth header and content type", async () => {
  let capturedHeaders: any = null
  const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = new Headers(init?.headers)
    return new Response(JSON.stringify({ id: "order_123", status: "paid" }), { status: 200 })
  }) as typeof fetch

  const res = await razorpayGet("orders/order_123", { fetchFn: mockFetch })
  assertEquals(res.id, "order_123")
  assertEquals(capturedHeaders?.get("Content-Type"), "application/json")
  assertEquals(capturedHeaders?.get("Authorization"), "Basic " + btoa("rzp_test_key_123:rzp_test_secret_456"))
})

Deno.test("razorpayGet retries on transient 502 Bad Gateway and succeeds", async () => {
  let attempts = 0
  const mockFetch = (async () => {
    attempts++
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: { description: "Bad Gateway" } }), { status: 502 })
    }
    return new Response(JSON.stringify({ id: "order_502_recovered" }), { status: 200 })
  }) as typeof fetch

  const res = await razorpayGet("orders/order_recovered", { fetchFn: mockFetch, maxRetries: 3 })
  assertEquals(attempts, 2)
  assertEquals(res.id, "order_502_recovered")
})

Deno.test("razorpayGet retries on 429 Rate Limit and respects Retry-After", async () => {
  let attempts = 0
  const startTime = Date.now()
  const mockFetch = (async () => {
    attempts++
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: { description: "Too many requests" } }), {
        status: 429,
        headers: { "Retry-After": "1" },
      })
    }
    return new Response(JSON.stringify({ id: "rate_limit_recovered" }), { status: 200 })
  }) as typeof fetch

  const res = await razorpayGet("orders/rate_limit", { fetchFn: mockFetch, maxRetries: 2 })
  const elapsed = Date.now() - startTime
  assertEquals(attempts, 2)
  assertEquals(res.id, "rate_limit_recovered")
  assert(elapsed >= 950, `Expected elapsed >= 950ms for Retry-After: 1, got ${elapsed}ms`)
})

Deno.test("razorpayRequest never retries 4xx client errors (permanent failure)", async () => {
  let attempts = 0
  const mockFetch = (async () => {
    attempts++
    return new Response(JSON.stringify({ error: { description: "Invalid account ID", code: "BAD_REQUEST_ERROR" } }), {
      status: 400,
    })
  }) as typeof fetch

  await assertRejects(
    async () => {
      await razorpayGet("payments/pay_invalid", { fetchFn: mockFetch, maxRetries: 3 })
    },
    RazorpayClientError,
    "Invalid account ID",
  )
  assertEquals(attempts, 1, "4xx client error must never retry")
})

Deno.test("razorpayPost order with idempotency key attaches header and retries on 503", async () => {
  let attempts = 0
  let capturedIdempotencyHeader: string | null = null
  const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    attempts++
    const h = new Headers(init?.headers)
    capturedIdempotencyHeader = h.get("X-Razorpay-Idempotency-Key")
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: { description: "Service Unavailable" } }), { status: 503 })
    }
    return new Response(JSON.stringify({ id: "order_idempotent_123" }), { status: 201 })
  }) as typeof fetch

  const res = await razorpayPost("orders", { amount: 5000, currency: "INR" }, {
    idempotencyKey: "order_reg_1_attempt_1",
    fetchFn: mockFetch,
    maxRetries: 2,
  })
  assertEquals(attempts, 2)
  assertEquals(capturedIdempotencyHeader, "order_reg_1_attempt_1")
  assertEquals(res.id, "order_idempotent_123")
})

Deno.test("Official Razorpay refund idempotency header X-Refund-Idempotency attached on refund POST", async () => {
  let capturedRefundIdempotencyHeader: string | null = null
  let capturedRazorpayIdempotencyHeader: string | null = null
  const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers)
    capturedRefundIdempotencyHeader = h.get("X-Refund-Idempotency")
    capturedRazorpayIdempotencyHeader = h.get("X-Razorpay-Idempotency-Key")
    return new Response(JSON.stringify({ id: "rfnd_idemp_abc", status: "processed", amount: 5000 }), { status: 200 })
  }) as typeof fetch

  const res = await razorpayPost("payments/pay_123/refund", { amount: 5000 }, {
    idempotencyKey: "ref_pay_123_attempt_1",
    fetchFn: mockFetch,
  })
  assertEquals(res.id, "rfnd_idemp_abc")
  assertEquals(capturedRefundIdempotencyHeader, "ref_pay_123_attempt_1", "Must attach official X-Refund-Idempotency header")
  assertEquals(capturedRazorpayIdempotencyHeader, null, "Must NOT attach generic X-Razorpay-Idempotency-Key on refund")
})

Deno.test("Uncertainty Protocol: refund POST 409 Conflict throws RazorpayUncertainOutcomeError", async () => {
  let attempts = 0
  const mockFetch = (async () => {
    attempts++
    return new Response(
      JSON.stringify({ error: { description: "Refund request is actively being processed" } }),
      { status: 409 },
    )
  }) as typeof fetch

  await assertRejects(
    async () => {
      await razorpayPost("payments/pay_409/refund", { amount: 5000 }, {
        idempotencyKey: "ref_pay_409_attempt_1",
        fetchFn: mockFetch,
      })
    },
    RazorpayUncertainOutcomeError,
    "actively being processed",
  )
  assertEquals(attempts, 1, "409 must not blind retry")
})

Deno.test("Uncertainty Protocol: refund POST timeout NEVER blindly retries", async () => {
  let attempts = 0
  const mockFetch = (async () => {
    attempts++
    // Simulate abort error (timeout)
    const err = new Error("The operation was aborted")
    err.name = "AbortError"
    throw err
  }) as typeof fetch

  await assertRejects(
    async () => {
      await razorpayPost("payments/pay_timeout/refund", { amount: 5000 }, {
        fetchFn: mockFetch,
        timeoutMs: 100,
        maxRetries: 3, // Even with maxRetries=3, refund POST must NOT retry
      })
    },
    RazorpayUncertainOutcomeError,
    "Outcome is uncertain",
  )
  assertEquals(attempts, 1, "Refund POST timeout must NEVER blindly retry")
})

Deno.test("Uncertainty Protocol: refund POST 500/502/504 server error NEVER blindly retries", async () => {
  let attempts = 0
  const mockFetch = (async () => {
    attempts++
    return new Response(JSON.stringify({ error: { description: "Internal Server Error" } }), { status: 500 })
  }) as typeof fetch

  await assertRejects(
    async () => {
      await razorpayPost("payments/pay_500/refund", { amount: 5000 }, {
        fetchFn: mockFetch,
        maxRetries: 3,
      })
    },
    RazorpayUncertainOutcomeError,
    "Outcome is uncertain",
  )
  assertEquals(attempts, 1, "Refund POST 5xx must NEVER blindly retry")
})

Deno.test("Uncertainty Protocol: attemptRefund preserves claimed state when provider outcome is uncertain", async () => {
  const { attemptRefund } = await import("../functions/_shared/refunds.ts")

  let completions: any[] = []
  const db = {
    rpc: async (name: string, args: any) => {
      if (name === "claim_payment_refund") {
        return { data: { ok: true, attempt: 1, stale_reclaimed: false }, error: null }
      }
      if (name === "complete_payment_refund") {
        completions.push(args)
        return { data: { ok: true }, error: null }
      }
      throw new Error(`Unexpected rpc: ${name}`)
    },
  }

  // Mock global fetch: POST /refund returns 500, GET /refunds returns empty
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: URL | RequestInfo | string, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? "GET").toUpperCase()
    if (method === "POST" && u.includes("/refund")) {
      return new Response(JSON.stringify({ error: { description: "Gateway timeout / 500" } }), { status: 500 })
    }
    if (method === "GET" && u.includes("/refunds")) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }
    throw new Error(`Unexpected fetch: ${method} ${u}`)
  }) as typeof fetch

  try {
    await assertRejects(
      async () => {
        await attemptRefund(
          db as any,
          { id: "pay_uncertain_1", razorpay_payment_id: "rzp_pay_1" },
          1000,
          "event_cancellation",
        )
      },
      RazorpayUncertainOutcomeError,
      "Outcome is uncertain",
    )

    // Verify claim was NOT released as failed!
    const failedCompletions = completions.filter((c) => c.p_success === false)
    assertEquals(
      failedCompletions.length,
      0,
      "Uncertainty Protocol MUST NEVER release the claim as failed when provider outcome is uncertain!",
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("Uncertainty Protocol: attemptRefund recovers when refund was accepted despite uncertain POST error", async () => {
  const { attemptRefund } = await import("../functions/_shared/refunds.ts")

  let completions: any[] = []
  const db = {
    rpc: async (name: string, args: any) => {
      if (name === "claim_payment_refund") {
        return { data: { ok: true, attempt: 1, stale_reclaimed: false }, error: null }
      }
      if (name === "complete_payment_refund") {
        completions.push(args)
        return { data: { ok: true }, error: null }
      }
      throw new Error(`Unexpected rpc: ${name}`)
    },
  }

  // Mock global fetch: POST /refund returns 500, but GET /refunds immediately lists the created refund!
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: URL | RequestInfo | string, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? "GET").toUpperCase()
    if (method === "POST" && u.includes("/refund")) {
      return new Response(JSON.stringify({ error: { description: "Gateway timeout / 500" } }), { status: 500 })
    }
    if (method === "GET" && u.includes("/refunds")) {
      return new Response(JSON.stringify({ items: [{ id: "rfnd_recovered_1", status: "processed", amount: 1000 }] }), { status: 200 })
    }
    throw new Error(`Unexpected fetch: ${method} ${u}`)
  }) as typeof fetch

  try {
    const outcome = await attemptRefund(
      db as any,
      { id: "pay_uncertain_2", razorpay_payment_id: "rzp_pay_2" },
      1000,
      "event_cancellation",
    )

    assertEquals(outcome.status, "issued")
    assertEquals(outcome.recovered, true)
    assertEquals(outcome.refund_id, "rfnd_recovered_1")

    const successCompletions = completions.filter((c) => c.p_success === true)
    assertEquals(successCompletions.length, 1)
    assertEquals(successCompletions[0].p_refund_id, "rfnd_recovered_1")
  } finally {
    globalThis.fetch = originalFetch
  }
})
