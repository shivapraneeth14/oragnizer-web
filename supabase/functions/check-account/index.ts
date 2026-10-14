import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { findUserByEmail } from "../_shared/users.ts"
import { sha256Hex } from "../_shared/otp.ts"
import {
  decideNextStep,
  isValidEmail,
  normalizeEmail,
  NEXT_STEP_MESSAGES,
} from "../_shared/account-step.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
}

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  })

// Email-first entry point. Given an email, tells the client whether to ask for a
// password, send the user through Google, or start signup — and nothing more.
//
// It never reveals whether the account is an organizer, an admin, deleted or
// banned; those states are decided AFTER authentication (role routing, banned
// sign-in rejection). Account existence itself is unavoidably observable here,
// but it is already public through register / the GoTrue signup endpoint; this
// endpoint deliberately leaks no *additional* fact.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  const ip = getClientIp(req)
  const ipLimit = await checkRateLimit(ip, "check-account")
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfter)

  try {
    const body = await req.json().catch(() => ({}))
    const rawEmail = typeof body?.email === "string" ? body.email : ""

    if (!isValidEmail(normalizeEmail(rawEmail))) {
      return jsonResponse({ error: "Please enter a valid email address." }, 400)
    }

    const email = normalizeEmail(rawEmail)

    // Second, tighter limit keyed by the email itself (hashed so the rate-limit
    // store never holds a raw address). This throttles someone probing many
    // addresses from rotating IPs.
    const emailLimit = await checkRateLimit(await sha256Hex(email), "check-account-email")
    if (!emailLimit.allowed) return rateLimitResponse(emailLimit.retryAfter)

    const user = await findUserByEmail(supabase, email)

    let hasPassword = false
    if (user) {
      const { data, error } = await supabase.rpc("user_has_password", { p_user_id: user.id })
      // Fail closed-ish: if the authoritative check is unavailable we must not
      // guess "google" for a password account (which would dead-end the user) or
      // "password" for a Google account. A transient error surfaces as retryable.
      if (error) throw error
      hasPassword = data === true
    }

    const next = decideNextStep({ userExists: Boolean(user), hasPassword })
    return jsonResponse({ next, message: NEXT_STEP_MESSAGES[next] })
  } catch (err) {
    console.error(err)
    // Never guess a route on failure — the client shows a retry.
    return jsonResponse({ error: "Something went wrong. Please try again." }, 500)
  }
})
