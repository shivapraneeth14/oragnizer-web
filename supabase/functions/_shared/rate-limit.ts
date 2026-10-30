import { optionalEnv, requiredEnv } from "./env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

// HMAC-pepper the rate-limit identifier before it is written to the
// rate_limits table. Raw client IPs and user UUIDs are personal data;
// hashing them with a server-side pepper means a database dump of
// rate_limits reveals nothing about who was rate-limited. The pepper
// is optional for local dev — without it the identifier is stored raw
// (matching previous behavior) so tests and `supabase start` keep working.
const RATE_LIMIT_PEPPER = optionalEnv("RATE_LIMIT_PEPPER")

async function pepperIdentifier(identifier: string): Promise<string> {
  const pepper = RATE_LIMIT_PEPPER || supabaseServiceKey
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(pepper),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(identifier))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

export interface RateLimitConfig {
  maxRequests: number
  windowSeconds: number
  action: string
}

const DEFAULTS: Record<string, RateLimitConfig> = {
  register: { maxRequests: 5, windowSeconds: 300, action: "register" },
  "check-account": { maxRequests: 30, windowSeconds: 60, action: "check_account" },
  "check-account-email": { maxRequests: 10, windowSeconds: 300, action: "check_account_email" },
  "check-username": { maxRequests: 30, windowSeconds: 60, action: "check_username" },
  "check-community-name": { maxRequests: 30, windowSeconds: 60, action: "check_community_name" },
  login: { maxRequests: 10, windowSeconds: 300, action: "login" },
  "complete-google-profile": { maxRequests: 10, windowSeconds: 300, action: "complete_google_profile" },
  "check-organizer": { maxRequests: 60, windowSeconds: 60, action: "check_organizer" },
  "create-payment": { maxRequests: 10, windowSeconds: 300, action: "create_payment" },
  "cleanup-booking": { maxRequests: 10, windowSeconds: 300, action: "cleanup_booking" },
  "cancel-registration": { maxRequests: 10, windowSeconds: 300, action: "cancel_registration" },
  "seed-admin": { maxRequests: 3, windowSeconds: 3600, action: "seed_admin" },
  "admin-delete-user": { maxRequests: 10, windowSeconds: 300, action: "admin_delete_user" },
  "admin-undelete-user": { maxRequests: 10, windowSeconds: 300, action: "admin_undelete_user" },
  "admin-list-profiles": { maxRequests: 60, windowSeconds: 60, action: "admin_list_profiles" },
  "organizer-contacts": { maxRequests: 60, windowSeconds: 60, action: "organizer_contacts" },
  "delete-account": { maxRequests: 5, windowSeconds: 300, action: "delete_account" },
  "verify-payment-webhook": { maxRequests: 600, windowSeconds: 60, action: "verify_payment_webhook" },
  "reconcile-payments": { maxRequests: 30, windowSeconds: 60, action: "reconcile_payments" },
  "create-community": { maxRequests: 3, windowSeconds: 600, action: "create_community" },
  "check-community-email": { maxRequests: 30, windowSeconds: 60, action: "check_community_email" },
  "create-beneficiary": { maxRequests: 5, windowSeconds: 600, action: "create_beneficiary" },
  "check-in": { maxRequests: 100, windowSeconds: 60, action: "check_in" },
  "forgot-password": { maxRequests: 10, windowSeconds: 300, action: "forgot_password" },
  "verify-otp": { maxRequests: 10, windowSeconds: 300, action: "verify_otp" },
  "change-password": { maxRequests: 10, windowSeconds: 300, action: "change_password" },
  "cancel-event": { maxRequests: 5, windowSeconds: 300, action: "cancel_event" },
  "issue-refund": { maxRequests: 10, windowSeconds: 300, action: "issue_refund" },
  "remove-beneficiary": { maxRequests: 10, windowSeconds: 600, action: "remove_beneficiary" },
  "switch-active-beneficiary": { maxRequests: 10, windowSeconds: 600, action: "switch_active_beneficiary" },
  "get-wallet-statement": { maxRequests: 30, windowSeconds: 60, action: "get_wallet_statement" },
  "delete-media": { maxRequests: 20, windowSeconds: 300, action: "delete_media" },
}

export async function checkRateLimit(
  identifier: string,
  functionName: string,
  config?: RateLimitConfig,
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  const cfg = config ?? DEFAULTS[functionName]
  if (!cfg) return { allowed: true, remaining: 999, retryAfter: 0 }

  const { data } = await supabase.rpc("check_rate_limit", {
    p_identifier: await pepperIdentifier(identifier),
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
