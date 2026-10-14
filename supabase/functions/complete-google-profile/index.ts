import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { CONSENT_VERSION, isValidConsentSource } from "../_shared/consent.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
}

const json = (body: Record<string, unknown>, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  })

function bearerToken(req: Request): string {
  const header = req.headers.get("Authorization") ?? ""
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""
}

// Completes an OAuth (Google) signup on the organizer web after the user has
// picked a username/name. The browser used to write these fields straight into
// `profiles` (trusting client input); this function owns that write with
// server-side validation and an atomic uniqueness check, and records consent.
//
// verify_jwt defaults to true (no [functions.complete-google-profile] override),
// so the platform rejects calls without a valid session before we run.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405)
  }

  const jwt = bearerToken(req)
  if (!jwt) return json({ error: "Missing bearer token." }, 401)

  const { data: userData, error: userError } = await supabase.auth.getUser(jwt)
  if (userError || !userData.user) {
    return json({ error: "Invalid or expired token." }, 401)
  }
  const user = userData.user

  const ip = getClientIp(req)
  const rl = await checkRateLimit(ip, "complete-google-profile")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  try {
    // Only these fields are read from the client. Consent version and
    // accepted_at are always server-controlled (constant + column default).
    const { first_name, last_name, username, consent_accepted, source } = await req.json()

    const errors: string[] = []
    if (!first_name || typeof first_name !== "string") errors.push("Please enter your first name.")
    if (!last_name || typeof last_name !== "string") errors.push("Please enter your last name.")
    if (!username || typeof username !== "string") errors.push("Please enter a username.")
    if (consent_accepted !== true) {
      errors.push("Please accept the Privacy Policy and Terms of Service to continue.")
    }
    if (errors.length > 0) {
      return json({ error: errors[0] }, 400)
    }

    const cleanUsername = username.trim()

    // Uniqueness, excluding the caller's own row (they may re-submit) and
    // soft-deleted rows. The profiles.username unique constraint is the final
    // backstop against a concurrent claim.
    const { data: taken } = await supabase
      .from("profiles")
      .select("id")
      .eq("username", cleanUsername)
      .is("deleted_at", null)
      .neq("id", user.id)
      .maybeSingle()
    if (taken) {
      return json({ error: "This username is already taken. Try another." }, 409)
    }

    const { error: updateError } = await supabase
      .from("profiles")
      .update({
        first_name: first_name.trim(),
        last_name: last_name.trim(),
        username: cleanUsername,
      })
      .eq("id", user.id)

    if (updateError) {
      // 23505 = unique_violation: a concurrent signup grabbed the username
      // between our check and the write.
      if (updateError.code === "23505") {
        return json({ error: "This username is already taken. Try another." }, 409)
      }
      console.error(updateError)
      return json({ error: "Could not save your details. Try again." }, 500)
    }

    // Consent record: idempotent, server-side (mirrors record-consent).
    const { data: existingConsent } = await supabase
      .from("consent_log")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle()
    if (!existingConsent) {
      await supabase.from("consent_log").insert({
        user_id: user.id,
        consent_version: CONSENT_VERSION,
        source: isValidConsentSource(source) ? source : "web",
      })
    }

    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: "google_profile_completed",
      target_type: "user",
      target_id: user.id,
      details: {},
    })

    return json({ success: true })
  } catch (err) {
    console.error(err)
    return json({ error: "Something went wrong. Try again." }, 500)
  }
})
