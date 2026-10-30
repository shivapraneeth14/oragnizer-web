import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { hasConsentRecord } from "../_shared/consent.ts"
import { isDeletionPending, deletionPendingResponse } from "../_shared/deletion.ts"
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
      return new Response(JSON.stringify({ error: "Unauthorized. Please sign in again." }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session. Please sign in again." }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Server-side consent backstop: no registration without a recorded policy
    // consent (see _shared/consent.ts). Any recorded version suffices.
    if (!(await hasConsentRecord(supabase, user.id))) {
      return new Response(JSON.stringify({ error: "Please accept the Privacy Policy and Terms of Service to continue." }), {
        status: 403, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (await isDeletionPending(supabase, user.id)) return deletionPendingResponse()

    const { event_id } = await req.json()

    if (!event_id) {
      return new Response(JSON.stringify({ error: "Event ID is required." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Atomic free registration: event lock + capacity check with active holds + registration insertion + count increment
    const { data: regResult, error: regRpcError } = await supabase.rpc("register_free_event", {
      p_event_id: event_id,
      p_user_id: user.id,
    })

    if (regRpcError) {
      logError("register-for-event rpc", regRpcError)
      return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
        status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (!regResult?.ok) {
      const errCode = regResult?.error
      const status = (errCode === "event_not_found") ? 404
        : (errCode === "event_deleted" || errCode === "event_cancelled" || errCode === "event_completed" || errCode === "event_started" || errCode === "event_unavailable") ? 410
        : (errCode === "payment_required") ? 402
        : (errCode === "capacity_full") ? 409
        : (errCode === "community_closing") ? 403
        : (errCode === "unauthorized") ? 403
        : 400

      return new Response(JSON.stringify({ error: regResult?.message || "Registration failed.", code: errCode }), {
        status, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    return new Response(JSON.stringify({
      success: true,
      registration_id: regResult.registration_id,
      already_registered: regResult.already_registered === true
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    logError("register-for-event", err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
