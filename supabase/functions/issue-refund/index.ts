import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const RAZORPAY_KEY_ID = requiredEnv("RAZORPAY_KEY_ID")
const RAZORPAY_KEY_SECRET = requiredEnv("RAZORPAY_KEY_SECRET")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
}

async function razorpayPost(path: string, body: any) {
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.description || "Razorpay API error")
  return data
}

function mapRefundStatus(status: string | undefined): string {
  switch (status) {
    case "processed":
      return "processed"
    case "pending":
    case "queued":
      return "pending"
    case "failed":
    case "reversed":
      return "failed"
    default:
      return "pending"
  }
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
// Receipt is attempt-suffixed: a failed Razorpay attempt keeps its receipt
// reserved, so retries must use a fresh one.
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
      .select("id, status, refund_status, refund_attempt_count, razorpay_payment_id, amount, registration_id")
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
      .select("id, event_id, user_id")
      .eq("id", payment.registration_id)
      .maybeSingle()
    if (!registration) return new Response(JSON.stringify({ error: "Registration not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: event } = await supabase
      .from("events")
      .select("id, community_id, title")
      .eq("id", registration.event_id)
      .maybeSingle()
    if (!event) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })

    if (!await isAuthorized(user.id, event.community_id)) {
      return new Response(JSON.stringify({ error: "Not authorized to refund this payment" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: community } = await supabase
      .from("communities")
      .select("id, commission_percent")
      .eq("id", event.community_id)
      .maybeSingle()

    const attempt = (payment.refund_attempt_count ?? 0) + 1
    const refund = await razorpayPost(`payments/${payment.razorpay_payment_id}/refund`, {
      amount: payment.amount,
      receipt: `ref_${payment.id}_${attempt}`,
    })
    const mappedStatus = mapRefundStatus(refund.status)

    await supabase.from("payments").update({
      status: "refunded",
      refund_status: mappedStatus,
      refund_attempt_count: attempt,
      razorpay_refund_id: refund.id,
      refunded_amount: payment.amount,
    }).eq("id", payment.id)

    await supabase.from("payment_audit_log").insert({
      action: "refund_issued",
      payment_id: payment.id,
      details: {
        refund_id: refund.id,
        amount: payment.amount,
        refund_status: mappedStatus,
        reason: "organizer_issue_refund",
        triggered_by: user.id,
        event_id: event.id,
      },
    })

    const baseAmount = Number(payment.amount)
    const platformFee = Math.floor(baseAmount * Number(community?.commission_percent ?? 10) / 100)
    const organizerShare = baseAmount - platformFee

    try {
      const { data: debitResult, error: debitError } = await supabase.rpc("debit_wallet", {
        p_community_id: event.community_id,
        p_amount: organizerShare,
        p_reason: "organizer_issue_refund",
        p_event_id: event.id,
      })
      if (debitError || debitResult?.error) throw new Error(debitResult?.error || debitError?.message || "Wallet debit failed")
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
    } catch (clawbackErr) {
      await supabase.from("payment_audit_log").insert({
        action: "refund_wallet_debit_failed",
        payment_id: payment.id,
        details: {
          refund_id: refund.id,
          amount: payment.amount,
          reason: "organizer_issue_refund",
          error: (clawbackErr as Error).message,
          note: "Customer refunded but organizer wallet clawback failed - manual follow-up required",
        },
      })
    }

    await supabase.from("notifications").insert({
      user_id: registration.user_id,
      type: "refund_initiated",
      title: "Refund Initiated",
      body: `Refund of ₹${(baseAmount / 100).toFixed(0)} for "${event.title}" has been initiated by the organizer.`,
      payload: { event_id: event.id, payment_id: payment.id, registration_id: registration.id, amount: baseAmount },
    })

    return new Response(JSON.stringify({ success: true, refund_id: refund.id, amount: payment.amount, status: mappedStatus }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: (err as Error).message || "Something went wrong" }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})