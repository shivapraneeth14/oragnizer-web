import { createClient } from "jsr:@supabase/supabase-js@2"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export interface RateLimitConfig {
  maxRequests: number
  windowSeconds: number
  action: string
}

const DEFAULTS: Record<string, RateLimitConfig> = {
  register: { maxRequests: 5, windowSeconds: 300, action: "register" },
  "check-username": { maxRequests: 30, windowSeconds: 60, action: "check_username" },
  "check-community-name": { maxRequests: 30, windowSeconds: 60, action: "check_community_name" },
  "create-payment-order": { maxRequests: 10, windowSeconds: 300, action: "create_payment_order" },
  "cancel-registration": { maxRequests: 10, windowSeconds: 300, action: "cancel_registration" },
  "onboard-razorpay-account": { maxRequests: 5, windowSeconds: 600, action: "onboard_razorpay" },
  "update-payout-account": { maxRequests: 5, windowSeconds: 600, action: "update_payout" },
  "seed-admin": { maxRequests: 3, windowSeconds: 3600, action: "seed_admin" },
  "admin-delete-user": { maxRequests: 10, windowSeconds: 300, action: "admin_delete_user" },
  "verify-payment-webhook": { maxRequests: 30, windowSeconds: 60, action: "verify_payment_webhook" },
  "razorpay-account-webhook": { maxRequests: 30, windowSeconds: 60, action: "razorpay_account_webhook" },
  "create-beneficiary": { maxRequests: 5, windowSeconds: 600, action: "create_beneficiary" },
  "withdraw-wallet": { maxRequests: 5, windowSeconds: 300, action: "withdraw_wallet" },
  "cashfree-webhook": { maxRequests: 30, windowSeconds: 60, action: "cashfree_webhook" },
}

export async function checkRateLimit(
  identifier: string,
  functionName: string,
  config?: RateLimitConfig,
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  const cfg = config ?? DEFAULTS[functionName]
  if (!cfg) return { allowed: true, remaining: 999, retryAfter: 0 }

  const { data } = await supabase.rpc("check_rate_limit", {
    p_identifier: identifier,
    p_action: cfg.action,
    p_max_requests: cfg.maxRequests,
    p_window_seconds: cfg.windowSeconds,
  }).single()

  const allowed = data === true
  return {
    allowed,
    remaining: allowed ? cfg.maxRequests - 1 : 0,
    retryAfter: cfg.windowSeconds,
  }
}

export function rateLimitResponse(retryAfter: number): Response {
  return new Response(JSON.stringify({ error: "Too many requests. Please wait before trying again." }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": retryAfter.toString(),
      "Access-Control-Allow-Origin": "*",
    },
  })
}

export function getClientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown"
}
