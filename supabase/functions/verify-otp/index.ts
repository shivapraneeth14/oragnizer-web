import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { findUserByEmail } from "../_shared/users.ts"
import { generateResetToken, otpMatches, sha256Hex } from "../_shared/otp.ts"

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

const RESET_TOKEN_TTL_SECONDS = 600
const MAX_ATTEMPTS = 5

const INVALID_CODE_MESSAGE = "Invalid or expired code. Try again."

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  const ip = getClientIp(req)
  const rl = await checkRateLimit(ip, "verify-otp")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  try {
    const { email, code } = await req.json()

    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return jsonResponse({ error: "Please enter a valid email address." }, 400)
    }
    if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
      return jsonResponse({ error: "Please enter the 6-digit code from the email." }, 400)
    }

    const normalizedEmail = email.trim().toLowerCase()

    // Unknown email gets the identical generic failure as a wrong code — same
    // no-enumeration behavior as forgot-password.
    const user = await findUserByEmail(supabase, normalizedEmail)
    if (!user) return jsonResponse({ error: INVALID_CODE_MESSAGE }, 400)

    const { data: row } = await supabase
      .from("password_reset_otps")
      .select("otp_hash, otp_attempts, otp_expires_at")
      .eq("user_id", user.id)
      .maybeSingle()

    if (!row?.otp_hash || !row.otp_expires_at) {
      return jsonResponse({ error: INVALID_CODE_MESSAGE }, 400)
    }

    if (new Date(row.otp_expires_at).getTime() < Date.now()) {
      // Expired — clear the hash so it cannot be replayed, then reply generically.
      await supabase
        .from("password_reset_otps")
        .update({ otp_hash: null, updated_at: new Date().toISOString() })
        .eq("user_id", user.id)
      return jsonResponse({ error: INVALID_CODE_MESSAGE }, 400)
    }

    if ((row.otp_attempts ?? 0) >= MAX_ATTEMPTS) {
      return jsonResponse(
        { error: "Too many attempts. Request a new code and try again." },
        429,
      )
    }

    const matches = await otpMatches(code.trim(), row.otp_hash)
    if (!matches) {
      const attempts = (row.otp_attempts ?? 0) + 1
      if (attempts >= MAX_ATTEMPTS) {
        // Locked out: destroy the code so the user must request a fresh one.
        await supabase
          .from("password_reset_otps")
          .update({ otp_attempts: attempts, otp_hash: null, updated_at: new Date().toISOString() })
          .eq("user_id", user.id)
        // Security trail: someone burned every attempt on this account's code.
        // service_role-only table; no client can read or forge these rows.
        await supabase.from("audit_log").insert({
          actor_id: user.id,
          action: "password_reset_otp_locked",
          target_type: "user",
          target_id: user.id,
          details: { attempts },
        })
        return jsonResponse(
          { error: "Too many attempts. Request a new code and try again." },
          429,
        )
      }
      await supabase
        .from("password_reset_otps")
        .update({ otp_attempts: attempts, updated_at: new Date().toISOString() })
        .eq("user_id", user.id)
      return jsonResponse({ error: INVALID_CODE_MESSAGE }, 400)
    }

    // Verified: consume the OTP (single-use) and mint the one-time reset token
    // that authorizes change-password.
    const token = generateResetToken()
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_SECONDS * 1000).toISOString()
    await supabase
      .from("password_reset_otps")
      .update({
        otp_hash: null,
        reset_token_hash: await sha256Hex(token),
        reset_token_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)

    return jsonResponse({ token, expiresIn: RESET_TOKEN_TTL_SECONDS })
  } catch (err) {
    console.error(err)
    return jsonResponse({ error: "Something went wrong. Try again." }, 500)
  }
})