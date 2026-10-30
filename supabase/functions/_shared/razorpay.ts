import { requiredEnv } from "./env.ts"

export interface RazorpayRequestOptions {
  method?: "GET" | "POST"
  body?: Record<string, unknown>
  idempotencyKey?: string
  timeoutMs?: number
  maxRetries?: number
  fetchFn?: typeof fetch
}

export class RazorpayRateLimitError extends Error {
  retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds: number) {
    super(message)
    this.name = "RazorpayRateLimitError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export class RazorpayTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RazorpayTimeoutError"
  }
}

export class RazorpayClientError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = "RazorpayClientError"
    this.status = status
    this.code = code
  }
}

export class RazorpayServerError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "RazorpayServerError"
    this.status = status
  }
}

export class RazorpayUncertainOutcomeError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "RazorpayUncertainOutcomeError"
    this.status = status
  }
}

function getRazorpayAuthHeader(): string {
  const keyId = requiredEnv("RAZORPAY_KEY_ID")
  const keySecret = requiredEnv("RAZORPAY_KEY_SECRET")
  return "Basic " + btoa(`${keyId}:${keySecret}`)
}

/**
 * Robust Razorpay API request handler with exponential backoff, full jitter,
 * and strict financial uncertainty protocol.
 */
export async function razorpayRequest<T = any>(
  path: string,
  options: RazorpayRequestOptions = {},
): Promise<T> {
  const method = options.method ?? "GET"
  const timeoutMs = options.timeoutMs ?? 15000
  const fetchImpl = options.fetchFn ?? fetch
  const isRefundPost = method === "POST" && path.includes("refund")
  const maxRetries = options.maxRetries ?? (method === "GET" ? 3 : (isRefundPost ? 1 : 2))

  let attempt = 0
  let lastError: Error | null = null

  while (attempt < maxRetries) {
    attempt++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: getRazorpayAuthHeader(),
      }
      if (options.idempotencyKey) {
        if (isRefundPost) {
          // Official Razorpay refund idempotency header (min 10 chars, [a-zA-Z0-9_-])
          headers["X-Refund-Idempotency"] = options.idempotencyKey
        } else {
          headers["X-Razorpay-Idempotency-Key"] = options.idempotencyKey
        }
      }

      const res = await fetchImpl(`https://api.razorpay.com/v1/${path}`, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      })

      clearTimeout(timer)

      // Handle 429 Rate Limit
      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("Retry-After")
        const waitSeconds = retryAfterHeader ? Math.max(parseInt(retryAfterHeader, 10), 1) : 1
        if (attempt < maxRetries) {
          const jitter = Math.random() * 200
          await new Promise((r) => setTimeout(r, waitSeconds * 1000 + jitter))
          continue
        }
        throw new RazorpayRateLimitError("Razorpay 429 Rate Limit exceeded", waitSeconds)
      }

      // Handle 5xx Server Errors (500, 502, 503, 504)
      if (res.status >= 500 && res.status <= 599) {
        // Strict Financial Uncertainty Protocol: NEVER blindly retry a refund POST!
        if (isRefundPost) {
          throw new RazorpayUncertainOutcomeError(
            `Razorpay server error (${res.status}) on refund request. Outcome is uncertain.`,
            res.status,
          )
        }

        // Other idempotent requests (GET or POST orders with idempotency key) can retry with backoff
        const canRetry = method === "GET" || Boolean(options.idempotencyKey)
        if (attempt < maxRetries && canRetry) {
          const backoff = Math.min(2000, Math.pow(2, attempt - 1) * 500) + Math.random() * 200
          await new Promise((r) => setTimeout(r, backoff))
          continue
        }
        const errBody = await res.json().catch(() => ({}))
        throw new RazorpayServerError(
          errBody.error?.description || `Razorpay server error (${res.status})`,
          res.status,
        )
      }

      // Handle 409 Conflict for refund POST (Razorpay actively processing identical key)
      if (res.status === 409 && isRefundPost) {
        const errBody = await res.json().catch(() => ({}))
        throw new RazorpayUncertainOutcomeError(
          errBody.error?.description || `Razorpay 409 Conflict: prior request with key is actively being processed.`,
          409,
        )
      }

      // Handle 4xx Client Errors (Permanent — Never retry)
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new RazorpayClientError(
          errBody.error?.description || `Razorpay error (${res.status})`,
          res.status,
          errBody.error?.code,
        )
      }

      return await res.json()
    } catch (err: any) {
      clearTimeout(timer)
      if (err.name === "AbortError") {
        if (isRefundPost) {
          throw new RazorpayUncertainOutcomeError(
            `Razorpay refund request to ${path} timed out after ${timeoutMs}ms. Outcome is uncertain.`,
          )
        }
        lastError = new RazorpayTimeoutError(`Razorpay request to ${path} timed out after ${timeoutMs}ms`)
      } else {
        lastError = err
      }

      // Permanent client errors must never retry
      if (err instanceof RazorpayClientError || err instanceof RazorpayUncertainOutcomeError) {
        throw err
      }

      // Safe to retry GET or idempotent POST on network drop
      const canRetry = method === "GET" || Boolean(options.idempotencyKey)
      if (attempt < maxRetries && canRetry && !(err instanceof RazorpayRateLimitError)) {
        const backoff = Math.min(2000, Math.pow(2, attempt - 1) * 500) + Math.random() * 200
        await new Promise((r) => setTimeout(r, backoff))
        continue
      }
      break
    }
  }

  throw lastError ?? new Error(`Razorpay request to ${path} failed after ${attempt} attempts`)
}

export async function razorpayGet<T = any>(
  path: string,
  options?: Omit<RazorpayRequestOptions, "method">,
): Promise<T> {
  return await razorpayRequest<T>(path, { ...options, method: "GET" })
}

export async function razorpayPost<T = any>(
  path: string,
  body?: Record<string, unknown>,
  options?: Omit<RazorpayRequestOptions, "method" | "body">,
): Promise<T> {
  return await razorpayRequest<T>(path, { ...options, method: "POST", body })
}

