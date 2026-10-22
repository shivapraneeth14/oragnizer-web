import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { attemptRefund } from "../_shared/refunds.ts"
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

// Authorize: community owner, MODERATOR/ORGANIZER member, or platform admin.
async function isAuthorized(userId: string, communityId: string): Promise<boolean> {
  const { data: community } = await supabase
    .from("communities")
    .select("owner_id")
    .eq("id", communityId)
    .maybeSingle()
  if (community?.owner_id === userId) return true

  const { data: member } = await supabase
    .from("community_members")
    .select("role")
    .eq("community_id", communityId)
    .eq("user_id", userId)
    .in("role", ["MODERATOR", "ORGANIZER"])
    .maybeSingle()
  if (member) return true

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle()
  return profile?.is_admin === true
}

// Organizer-initiated refund (e.g. member support, special case resolved
// outside the 24h window). FULL amount goes back to the customer — fee
// included, exactly like an organizer-cancelled event — because the
// organizer is the one choosing to cancel this booking.
// Refund issuance is claim-guarded by _shared/refunds.attemptRefund so two
// concurrent requests cannot refund the same payment twice; the loser gets a
// clean 409.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const token = authHeader.slice(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const rl = await checkRateLimit(user.id, "issue-refund")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { payment_id } = await req.json()
    if (!payment_id) return new Response(JSON.stringify({ error: "Payment ID required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: payment, error: paymentErr } = await supabase
      .from("payments")
      .select("id, status, refund_status, razorpay_payment_id, amount, registration_id, platform_fee, organizer_share")
      .eq("id", payment_id)
      .maybeSingle()
    if (paymentErr || !payment) return new Response(JSON.stringify({ error: "Payment not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })

    if (payment.status !== "success" || !payment.razorpay_payment_id) {
      return new Response(JSON.stringify({ error: "Payment is not refundable in its current state" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }
    if (payment.refund_status && !["requested", "failed"].includes(payment.refund_status)) {
      return new Response(JSON.stringify({ error: `Refund already ${payment.refund_status} for this payment` }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: registration } = await supabase
      .from("registrations")
      .select("id, event_id, user_id, status")
      .eq("id", payment.registration_id)
      .maybeSingle()
    if (!registration) return new Response(JSON.stringify({ error: "Registration not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })

    if (registration.status === "attended") {
      return new Response(JSON.stringify({ error: "Cannot refund — this attendee has already attended the event." }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: event } = await supabase
      .from("events")
      .select("id, community_id, title")
      .eq("id", registration.event_id)
      .maybeSingle()
    if (!event) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })

    if (!await isAuthorized(user.id, event.community_id)) {
      return new Response(JSON.stringify({ error: "Not authorized to refund this payment" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    let outcome
    try {
      outcome = await attemptRefund(supabase, payment, payment.amount, "organizer_issue_refund")
    } catch (err) {
      console.error("issue-refund error:", err)
      await supabase.from("payment_audit_log").insert({
        action: "refund_failed",
        payment_id: payment.id,
        details: { error: String(err), triggered_by: user.id, event_id: event.id },
      })
      return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    if (outcome.status === "conflict") {
      return new Response(JSON.stringify({ error: "Refund is already being processed for this payment." }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }
    if (outcome.status === "already_refunded") {
      return new Response(JSON.stringify({ error: `Refund already ${outcome.refund_status || "issued"} for this payment` }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const baseAmount = Number(payment.amount)
    // Split persisted at order creation — read it, never recompute a %.
    const platformFee = Math.max(Number(payment.platform_fee ?? 0), 0)
    if (platformFee > 0) {
      await supabase.from("payment_audit_log").insert({
        action: "commission_reversed",
        payment_id: payment.id,
        details: {
          commission_amount: platformFee,
          reason: "organizer_issue_refund",
          note: `Platform commission zeroed — organizer-initiated refund of ₹${(baseAmount / 100).toFixed(0)} includes our fee`,
        },
      })
    }

    if (registration.user_id) {
      await supabase.from("notifications").insert({
        user_id: registration.user_id,
        type: "refund_initiated",
        title: "Refund Initiated",
        body: `Refund of ₹${(baseAmount / 100).toFixed(0)} for "${event.title}" has been initiated by the organizer.`,
        payload: { event_id: event.id, payment_id: payment.id, registration_id: registration.id, amount: baseAmount },
      })
    }

    return new Response(JSON.stringify({ success: true, refund_id: outcome.refund_id, amount: payment.amount, status: outcome.refund_status }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    logError("issue-refund", err)
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})