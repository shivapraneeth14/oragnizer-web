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
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Max-Age": "86400",
}

type CheckInResult = {
  success: boolean
  message: string
  attendee_name: string | null
  event_title: string | null
  event_id: string | null
  registration_id: string | null
  already_checked_in: boolean
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

    const { qr_code, event_id: expectedEventId, community_id: expectedCommunityId } = await req.json()
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
        .select("id, title, community_id")
        .eq("id", reg.event_id)
        .single()

      if (event) {
        // If the scanner specified an event, verify the ticket is for this exact event
        if (expectedEventId && event.id !== expectedEventId) {
          return new Response(JSON.stringify({
            error: `Wrong event: This ticket is for "${event.title}", not this event.`
          }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }

        // If the scanner specified a community, verify the ticket belongs to that community
        if (expectedCommunityId && event.community_id !== expectedCommunityId) {
          return new Response(JSON.stringify({
            error: "This ticket belongs to another community's event."
          }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }

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
          return new Response(JSON.stringify({ error: "This ticket belongs to another organizer's event." }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
    } else {
      // F-7 fix: an unknown or deleted QR no longer falls through to the
      // RPC unauthenticated. The old code let any authenticated user reach
      // the RPC with an arbitrary QR string — the RPC returned a canonical
      // message, but the endpoint also confirmed the QR existed, leaking
      // a subtle existence oracle.
      return new Response(JSON.stringify({ error: "Invalid QR code" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    // Authorized (or QR unknown -> let the RPC return the canonical message):
    // now validate and mark attendance.
    const { data: rawResult, error: rpcErr } = await supabase
      .rpc("check_in_registration", { p_qr_code: qr_code })
      .single()
    const result = rawResult as CheckInResult | null

    if (rpcErr) {
      logError("check-in rpc", rpcErr)
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
    logError("check-in", err)
    return new Response(JSON.stringify({ error: "Check-in failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
