import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
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

// Admin-only restore for suspended or deletion-scheduled users. Suspended
// users have profiles.deleted_at + a GoTrue ban; grace users have
// profiles.deletion_grace_started_at and no ban. Restoring clears both modes
// and writes an audit entry (never the email).
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

    const rl = await checkRateLimit(user.id, "admin-undelete-user")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { user_id } = await req.json()
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id is required." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: profileData } = await supabase
      .from("profiles")
      .select("id, deleted_at, deletion_grace_started_at, deletion_purging_at")
      .eq("id", user_id)
      .single()

    if (!profileData) {
      return new Response(JSON.stringify({ error: "User not found." }), {
        status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }
    if (profileData.deletion_purging_at) {
      return new Response(JSON.stringify({
        error: "This account is currently being purged and can no longer be restored.",
      }), {
        status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const isSuspended = Boolean(profileData.deleted_at)
    const isGrace = !isSuspended && Boolean(profileData.deletion_grace_started_at)
    if (!isSuspended && !isGrace) {
      return new Response(JSON.stringify({ error: "User is not deleted." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { error: updateErr } = await supabase
      .from("profiles")
      .update({
        deleted_at: null,
        deletion_grace_started_at: null,
        deletion_purging_at: null,
      })
      .eq("id", user_id)
    if (updateErr) throw updateErr

    // Suspended users are banned at the auth layer; grace users are not.
    // Lifting the ban is harmless when no ban exists.
    if (isSuspended) {
      const { error: banErr } = await supabase.auth.admin.updateUserById(user_id, {
        ban_duration: "none",
      })
      if (banErr) logError("admin-undelete-user unban", banErr)
    }

    const { error: auditErr } = await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: isGrace ? "deletion_cancelled_by_admin" : "user_restored",
      target_type: "user",
      target_id: user_id,
      details: { mode: isGrace ? "grace" : "suspend" },
    })
    if (auditErr) throw auditErr

    return new Response(JSON.stringify({
      success: true,
      mode: isGrace ? "grace" : "suspend",
    }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    logError("admin-undelete-user", err)
    return new Response(JSON.stringify({ error: "Something went wrong." }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
