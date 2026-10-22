import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { isOrganizerAccount } from "../_shared/organizer.ts"
import { findUserByEmail, hasEmailIdentity } from "../_shared/users.ts"
import { generateOtpCode, otpHash } from "../_shared/otp.ts"
import { sendCluvoEmail } from "../_shared/send-email.ts"
import { logError } from "../_shared/logger.ts"

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

const OTP_TTL_SECONDS = 600 // exactly 10 minutes
const RESEND_COOLDOWN_SECONDS = 30

// No-enumeration contract: the exact same reply is returned whether the email
// is unknown, Google-only, or (on the web) not an organizer account. The client
// shows this copy verbatim so a caller cannot tell an existing address from a
// missing one.
const UNIFIED_MESSAGE =
  "If your email uses password login, a verification code has been sent. " +
  "If it uses Google, please sign in with Google instead."

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  const ip = getClientIp(req)
  const rl = await checkRateLimit(ip, "forgot-password")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  try {
    const { email, requireOrganizer } = await req.json()

    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return jsonResponse({ error: "Please enter a valid email address." }, 400)
    }

    const normalizedEmail = email.trim().toLowerCase()

    const user = await findUserByEmail(supabase, normalizedEmail)
    if (!user) {
      return jsonResponse({ sent: false, message: UNIFIED_MESSAGE })
    }

    // Google-only accounts have no password to reset — no code is sent, but the
    // reply stays identical to every other non-send case.
    if (!hasEmailIdentity(user.identities ?? [])) {
      return jsonResponse({ sent: false, message: UNIFIED_MESSAGE })
    }

    if (requireOrganizer === true) {
      const isOrganizer = await isOrganizerAccount(supabase, user.id)
      if (!isOrganizer) {
        return jsonResponse({ sent: false, message: UNIFIED_MESSAGE })
      }
    }

    // Server-side resend cooldown: an active code created less than 30 seconds
    // ago blocks another send, even if the client timer is bypassed.
    const { data: existing } = await supabase
      .from("password_reset_otps")
      .select("otp_hash, otp_expires_at, created_at")
      .eq("user_id", user.id)
      .maybeSingle()
    if (
      existing?.otp_hash &&
      existing.otp_expires_at &&
      new Date(existing.otp_expires_at).getTime() > Date.now()
    ) {
      const created = new Date(existing.created_at).getTime()
      if (Date.now() - created < RESEND_COOLDOWN_SECONDS * 1000) {
        return jsonResponse(
          { error: "Please wait a moment before requesting another code." },
          429,
        )
      }
    }

    const code = generateOtpCode(6)
    const codeHash = await otpHash(code)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000).toISOString()

    // Upsert REPLACES the previous code (only the latest is valid) and wipes any
    // still-unused reset token, so a re-request cancels the whole earlier flow.
    const { error: upsertError } = await supabase.from("password_reset_otps").upsert({
      user_id: user.id,
      otp_hash: codeHash,
      otp_attempts: 0,
      otp_expires_at: expiresAt,
      reset_token_hash: null,
      reset_token_expires_at: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }, { onConflict: "user_id" })
    if (upsertError) throw upsertError

    await sendCluvoEmail(
      normalizedEmail,
      "Your Cluvo verification code",
      `Your Cluvo password reset code is ${code}. It expires in 10 minutes.\n\n` +
        `If you didn't request this, you can safely ignore this email and your password will stay the same.\n\n` +
        `— Cluvo`,
    )

    return jsonResponse({ sent: true, expiresIn: OTP_TTL_SECONDS })
  } catch (err) {
    logError("forgot-password", err)
    return jsonResponse({ error: "Something went wrong. Try again." }, 500)
  }
})