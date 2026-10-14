import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { sha256Hex } from "../_shared/otp.ts"
import { sendCluvoEmail } from "../_shared/send-email.ts"

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

const INVALID_RESET_MESSAGE = "This reset request is invalid or has expired. Please request a new code."

// Password policy is enforced on the SERVER, not just in the UI, so a
// hand-crafted request cannot set a weak password.
function validatePasswordServer(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters."
  if (!/[A-Z]/.test(password)) return "Password needs at least one capital letter."
  return null
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  const ip = getClientIp(req)
  const rl = await checkRateLimit(ip, "change-password")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  try {
    const { token, password } = await req.json()

    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
      return jsonResponse({ error: INVALID_RESET_MESSAGE }, 400)
    }
    if (typeof password !== "string" || password === "") {
      return jsonResponse({ error: "Please enter a new password." }, 400)
    }
    const policyError = validatePasswordServer(password)
    if (policyError) return jsonResponse({ error: policyError }, 400)

    const tokenHash = await sha256Hex(token)
    const { data: row } = await supabase
      .from("password_reset_otps")
      .select("user_id, reset_token_hash, reset_token_expires_at")
      .eq("reset_token_hash", tokenHash)
      .maybeSingle()

    if (!row?.reset_token_hash || !row.reset_token_expires_at) {
      return jsonResponse({ error: INVALID_RESET_MESSAGE }, 400)
    }
    if (new Date(row.reset_token_expires_at).getTime() < Date.now()) {
      return jsonResponse({ error: INVALID_RESET_MESSAGE }, 400)
    }

    // Update the EXISTING account's password. Profile/roles/data are untouched;
    // Supabase Auth invalidates the account's sessions on a password change.
    const { error: updateError } = await supabase.auth.admin.updateUserById(row.user_id, {
      password,
    })
    if (updateError) throw updateError

    // Consume the reset token — it is strictly one-time.
    await supabase
      .from("password_reset_otps")
      .update({ reset_token_hash: null, reset_token_expires_at: null, updated_at: new Date().toISOString() })
      .eq("user_id", row.user_id)

    // Security trail: a completed password reset (service_role-only table;
    // clients can neither read nor forge audit rows).
    await supabase.from("audit_log").insert({
      actor_id: row.user_id,
      action: "password_reset_completed",
      target_type: "user",
      target_id: row.user_id,
      details: {},
    })

    // Confirmation email (never includes the password). Best-effort: a failed
    // notification email must not fail the password change that already happened.
    try {
      const { data: user } = await supabase.auth.admin.getUserById(row.user_id)
      const email = user.user?.email
      if (email) {
        await sendCluvoEmail(
          email,
          "Your Cluvo password was changed",
          `The password for your Cluvo account was changed on ${new Date().toISOString()}.\n\n` +
            `If this was you, no further action is needed.\n\n` +
            `If you didn't make this change, please contact support immediately.\n\n— Cluvo`,
        )
      }
    } catch (err) {
      console.error("[change-password] confirmation email failed:", err)
    }

    return jsonResponse({ ok: true })
  } catch (err) {
    console.error(err)
    return jsonResponse({ error: "Something went wrong. Try again." }, 500)
  }
})