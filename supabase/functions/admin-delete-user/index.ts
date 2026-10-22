import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { GRACE_DAYS } from "../_shared/deletion.ts"
import { logError } from "../_shared/logger.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
}

// Two admin modes:
//   "suspend" (default) — reversible moderation action. Sets profiles.deleted_at
//     and a ~10-year auth ban. The user's data is preserved. This is the
//     existing behavior and remains the default so existing admin-web callers
//     keep working unchanged.
//   "grace" — starts the irreversible 30-day deletion grace period. The purge
//     job will hard-delete the account after 30 days. Used for GDPR erasure
//     requests and ToS violations requiring full removal.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized." }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session." }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single()
    if (!profile?.is_admin) {
      return new Response(JSON.stringify({ error: "Access denied." }), {
        status: 403, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const rl = await checkRateLimit(user.id, "admin-delete-user")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { user_id, mode } = await req.json()
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id is required." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (user_id === user.id) {
      return new Response(JSON.stringify({ error: "Cannot act on yourself." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const deletionMode: "suspend" | "grace" = mode === "grace" ? "grace" : "suspend"

    // Read deleted_at AND deletion_grace_started_at so both modes reject
    // already-processed users.
    const { data: profileData } = await supabase
      .from("profiles")
      .select("id, deleted_at, deletion_grace_started_at")
      .eq("id", user_id)
      .single()

    if (!profileData) {
      return new Response(JSON.stringify({ error: "User not found." }), {
        status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }
    if (profileData.deleted_at) {
      return new Response(JSON.stringify({ error: "User is already suspended." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }
    if (profileData.deletion_grace_started_at) {
      return new Response(JSON.stringify({ error: "User already has a pending deletion." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (deletionMode === "grace") {
      // Start the 30-day grace. No suspend-ban here: the user may still log
      // in to cancel their deletion during the grace window.
      const now = new Date().toISOString()
      const { error: graceErr } = await supabase
        .from("profiles")
        .update({ deletion_grace_started_at: now })
        .eq("id", user_id)
      if (graceErr) throw graceErr

      // No sign-out/ban: the user must be able to log in and cancel the
      // deletion during the grace window. (The Admin signOut API takes a JWT,
      // not a user id, so the old call was a silent no-op anyway.)

      // Audit: no email, no PII in details.
      await supabase.from("audit_log").insert({
        actor_id: user.id,
        action: "deletion_grace_started_by_admin",
        target_type: "user",
        target_id: user_id,
        details: { grace_days: GRACE_DAYS },
      })

      return new Response(JSON.stringify({
        success: true,
        mode: "grace",
        grace_days: GRACE_DAYS,
      }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // suspend mode (default, reversible).
    const now = new Date().toISOString()
    const { error: suspendErr } = await supabase
      .from("profiles")
      .update({ deleted_at: now })
      .eq("id", user_id)
    if (suspendErr) throw suspendErr
    // Auth-level ban: blocks fresh sign-ins (password AND Google OAuth) on every
    // client — the soft-delete timestamp alone is never consulted by GoTrue.
    // ~10 years: effectively permanent but reversible via admin-undelete-user.
    await supabase.auth.admin.updateUserById(user_id, { ban_duration: "87600h" })

    // Audit: NO email in details (D-fix: previously leaked the user's email
    // into audit_log.details, readable by any admin).
    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: "user_suspended",
      target_type: "user",
      target_id: user_id,
      details: null,
    })

    return new Response(JSON.stringify({ success: true, mode: "suspend" }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    logError("admin-delete-user", err)
    return new Response(JSON.stringify({ error: "Something went wrong." }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
