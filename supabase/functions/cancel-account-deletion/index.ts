import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
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

    const ip = getClientIp(req)
    const rl = await checkRateLimit(ip, "delete-account")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    // Idempotent: if not in grace, return success (nothing to cancel).
    const { data: profile } = await supabase
      .from("profiles")
      .select("deletion_grace_started_at, deletion_purging_at")
      .eq("id", user.id)
      .single()

    if (!profile?.deletion_grace_started_at) {
      return new Response(JSON.stringify({ success: true, cancelled: false }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // If the purge job has already claimed this user, cancellation is too late.
    if (profile.deletion_purging_at) {
      return new Response(JSON.stringify({
        error: "Your account is being permanently deleted and can no longer be restored.",
      }), {
        status: 409,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Clear the grace period.
    const { error: clearErr } = await supabase
      .from("profiles")
      .update({
        deletion_grace_started_at: null,
        deletion_purging_at: null,
      })
      .eq("id", user.id)
    if (clearErr) throw clearErr

    // Audit.
    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: "deletion_cancelled",
      target_type: "user",
      target_id: user.id,
      details: null,
    })

    return new Response(JSON.stringify({ success: true, cancelled: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    logError("cancel-account-deletion", err)
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
