import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Max-Age": "86400",
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const rl = await checkRateLimit(user.id, "check-in")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { qr_code } = await req.json()
    if (!qr_code || typeof qr_code !== "string") {
      return new Response(JSON.stringify({ error: "qr_code is required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    // Authorize BEFORE mutating: look up the registration's event (read-only)
    // and confirm the caller can manage check-ins for that community.
    const { data: reg } = await supabase
      .from("registrations")
      .select("event_id")
      .eq("qr_code", qr_code)
      .is("deleted_at", null)
      .maybeSingle()

    if (reg?.event_id) {
      const { data: event } = await supabase
        .from("events")
        .select("community_id")
        .eq("id", reg.event_id)
        .single()

      if (event) {
        const { data: community } = await supabase
          .from("communities")
          .select("owner_id")
          .eq("id", event.community_id)
          .single()

        let authorized = community?.owner_id === user.id

        if (!authorized) {
          const { data: member } = await supabase
            .from("community_members")
            .select("role")
            .eq("community_id", event.community_id)
            .eq("user_id", user.id)
            .in("role", ["MODERATOR", "ORGANIZER"])
            .maybeSingle()
          if (member) authorized = true
        }

        if (!authorized) {
          const { data: adminProfile } = await supabase
            .from("profiles")
            .select("is_admin")
            .eq("id", user.id)
            .maybeSingle()
          if (adminProfile?.is_admin) authorized = true
        }

        if (!authorized) {
          return new Response(JSON.stringify({ error: "Not authorized to check in" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
    }

    // Authorized (or QR unknown -> let the RPC return the canonical message):
    // now validate and mark attendance.
    const { data: result, error: rpcErr } = await supabase
      .rpc("check_in_registration", { p_qr_code: qr_code })
      .single()

    if (rpcErr) {
      console.error("check_in_registration RPC error:", rpcErr)
      return new Response(JSON.stringify({ error: "Check-in failed" }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    if (!result) {
      return new Response(JSON.stringify({ error: "Invalid QR code" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    return new Response(JSON.stringify({
      success: result.success,
      message: result.message,
      attendee_name: result.attendee_name,
      event_title: result.event_title,
      event_id: result.event_id,
      registration_id: result.registration_id,
      already_checked_in: result.already_checked_in,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    console.error("check-in error:", err)
    return new Response(JSON.stringify({ error: "Check-in failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
