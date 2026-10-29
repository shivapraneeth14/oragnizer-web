import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { logError } from "../_shared/logger.ts"
import { GRACE_DAYS } from "../_shared/deletion.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
}

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

    const rl = await checkRateLimit(user.id, "admin-delete-community")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { community_id } = await req.json()
    if (!community_id) {
      return new Response(JSON.stringify({ error: "community_id is required." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: community } = await supabase
      .from("communities")
      .select("id, name, deleted_at, deletion_grace_started_at, closed_at, wallet_balance, is_hidden")
      .eq("id", community_id)
      .single()

    if (!community) {
      return new Response(JSON.stringify({ error: "Community not found." }), {
        status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (community.closed_at) {
      return new Response(JSON.stringify({ error: "Community is already closed." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (community.deletion_grace_started_at) {
      return new Response(JSON.stringify({ error: "Community closure is already scheduled." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const now = new Date()

    // Active community subscription
    const { data: subs } = await supabase
      .from("community_subscriptions")
      .select("id, status")
      .eq("community_id", community_id)
    const activeSubs = (subs || []).filter((s: any) => s.status === "active")
    if (activeSubs.length > 0) {
      return new Response(JSON.stringify({ error: "Cannot schedule closure. This community has an active subscription. Cancel or resolve the subscription first." }), {
        status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Events: must have NO upcoming, NO ongoing, and all must be completed or cancelled
    const { data: events } = await supabase
      .from("events")
      .select("id, status, start_date, end_date")
      .eq("community_id", community_id)
      .is("deleted_at", null)

    for (const e of events || []) {
      if (e.start_date) {
        const start = new Date(e.start_date)
        if (start > now) {
          if (e.status !== "cancelled" && e.status !== "completed") {
            return new Response(JSON.stringify({ error: "Cannot schedule closure. This community has an upcoming event. Complete or cancel all events first." }), {
              status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
            })
          }
        }
        if (start <= now) {
          const ended = e.end_date ? new Date(e.end_date) <= now : false
          if (!ended && e.status !== "cancelled" && e.status !== "completed") {
            return new Response(JSON.stringify({ error: "Cannot schedule closure. This community has an ongoing event. Complete or cancel all events first." }), {
              status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
            })
          }
        }
      }
      if (e.status === "published") {
        return new Response(JSON.stringify({ error: "Cannot schedule closure. All events must be completed or cancelled first." }), {
          status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
      if (e.status !== "completed" && e.status !== "cancelled") {
        return new Response(JSON.stringify({ error: "Cannot schedule closure. All events must be completed or cancelled first." }), {
          status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
    }

    const eventIds = (events || []).map((e: any) => e.id)
    if (eventIds.length > 0) {
      const { data: regs } = await supabase
        .from("registrations")
        .select("id, status")
        .in("event_id", eventIds)
        .is("deleted_at", null)
      const activeReg = (regs || []).find((r: any) => r.status === "pending" || r.status === "confirmed")
      if (activeReg) {
        return new Response(JSON.stringify({ error: "Cannot schedule closure. There are active registrations or bookings. Resolve them first." }), {
          status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }

      const regIds = (regs || []).map((r: any) => r.id)
      if (regIds.length > 0) {
        const { data: pendingPays } = await supabase
          .from("payments")
          .select("id")
          .in("registration_id", regIds)
          .eq("status", "pending")
        if (pendingPays && pendingPays.length > 0) {
          return new Response(JSON.stringify({ error: "Cannot schedule closure. There is a pending or processing payment. Wait for it to settle or fail first." }), {
            status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        }

        const { data: refundClaims } = await supabase
          .from("payments")
          .select("id")
          .in("registration_id", regIds)
          .eq("refund_claim_state", "claimed")
        if (refundClaims && refundClaims.length > 0) {
          return new Response(JSON.stringify({ error: "Cannot schedule closure. There is a pending or processing refund. Resolve it first." }), {
            status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        }

        const { data: refundStatuses } = await supabase
          .from("payments")
          .select("id")
          .in("registration_id", regIds)
          .in("refund_status", ["requested", "pending", "queued", "processing"])
        if (refundStatuses && refundStatuses.length > 0) {
          return new Response(JSON.stringify({ error: "Cannot schedule closure. There is a pending or processing refund. Resolve it first." }), {
            status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        }
      }
    }

    const { data: payoutItems } = await supabase
      .from("payout_items")
      .select("id, status")
      .eq("community_id", community_id)
      .in("status", ["pending", "processing"])
    if (payoutItems && payoutItems.length > 0) {
      return new Response(JSON.stringify({ error: "Cannot schedule closure. There are pending or processing payouts. Resolve them first." }), {
        status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if ((community.wallet_balance || 0) > 0) {
      return new Response(JSON.stringify({ error: "Cannot schedule closure. This community has an outstanding wallet balance. Resolve it first." }), {
        status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const scheduleAt = new Date().toISOString()

    const { error: scheduleErr } = await supabase
      .from("communities")
      .update({ 
        deletion_grace_started_at: scheduleAt,
        is_hidden_before_deletion: community.is_hidden,
        is_hidden: true,
      })
      .eq("id", community_id)
    if (scheduleErr) throw scheduleErr

    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: "community_closure_scheduled_by_admin",
      target_type: "community",
      target_id: community_id,
      details: { community_name: community.name, grace_days: GRACE_DAYS },
    })

    return new Response(JSON.stringify({ success: true, scheduled: true, grace_days: GRACE_DAYS, closure: true }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    logError("admin-delete-community", err)
    return new Response(JSON.stringify({ error: "Something went wrong." }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
