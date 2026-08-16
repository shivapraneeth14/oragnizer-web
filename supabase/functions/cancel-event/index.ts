import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

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

// Organizer-initiated cancellation refunds EVERY confirmed registration in
// FULL (customer gets the complete amount back, platform fee included). The
// organizer's wallet is debited by their share only; the platform's
// commission record for the transaction is zeroed via commission_reversed.
async function rebalanceRefund(
  community: { id: string; commission_percent: number | null },
  payment: { id: string; amount: number },
  via: "registration_cancellation" | "event_cancellation",
  eventId: string,
) {
  const platformFee = Math.floor(Number(payment.amount) * Number(community.commission_percent ?? 10) / 100)
  const organizerShare = Number(payment.amount) - platformFee

  const { data: debitResult, error: debitError } = await supabase.rpc("debit_wallet", {
    p_community_id: community.id,
    p_amount: organizerShare,
    p_reason: `${via}_refund`,
    p_event_id: eventId,
  })
  if (debitError || debitResult?.error) {
    throw new Error(debitResult?.error || debitError?.message || "Wallet debit failed")
  }

  if (platformFee > 0) {
    await supabase.from("payment_audit_log").insert({
      action: "commission_reversed",
      payment_id: payment.id,
      details: {
        commission_amount: platformFee,
        reason: via,
        note: `Platform commission zeroed — customer refunded the full ₹${(Number(payment.amount) / 100).toFixed(0)} including our fee`,
      },
    })
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const token = authHeader.slice(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const rl = await checkRateLimit(user.id, "cancel-event")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { event_id } = await req.json()
    if (!event_id) return new Response(JSON.stringify({ error: "Event ID required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: event, error: eventErr } = await supabase
      .from("events")
      .select("id, community_id, start_date, status")
      .eq("id", event_id)
      .single()

    if (eventErr || !event) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.status === "cancelled") return new Response(JSON.stringify({ error: "Event already cancelled" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: community } = await supabase
      .from("communities")
      .select("id, owner_id, commission_percent")
      .eq("id", event.community_id)
      .single()

    if (!community) return new Response(JSON.stringify({ error: "Community not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const isOwner = community.owner_id === user.id
    let authorized = isOwner

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
      return new Response(JSON.stringify({ error: "Not authorized to cancel this event" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: registrations } = await supabase
      .from("registrations")
      .select("id, user_id")
      .eq("event_id", event_id)
      .eq("status", "confirmed")
      .is("deleted_at", null)

    const confirmedRegs = registrations || []

    let payments: any[] = []
    if (confirmedRegs.length > 0) {
      const { data: p } = await supabase
        .from("payments")
        .select("id, amount, razorpay_payment_id, registration_id, status")
        .in("registration_id", confirmedRegs.map(r => r.id))
        .eq("status", "success")
      payments = p || []
    }

    let refunded = 0
    let failed = 0
    const errors: string[] = []

    // No exceptions: every confirmed registration gets a full refund.
    for (const payment of payments) {
      try {
        if (!payment.razorpay_payment_id) throw new Error(`Payment ${payment.id} has no razorpay_payment_id`)

        const refund = await razorpayPost(`payments/${payment.razorpay_payment_id}/refund`, { amount: payment.amount, receipt: `ref_${payment.id}` })

        const mappedStatus = mapRefundStatus(refund.status)

        // Record the truthful refund state FIRST (Razorpay accepted it), then
        // rebalance the wallet so a clawback failure is surfaced in the audit
        // log instead of round-tripping into a duplicate-receipt retry.
        await supabase.from("payments").update({
          status: "refunded",
          refund_status: mappedStatus,
          refund_attempt_count: 0,
          razorpay_refund_id: refund.id,
          refunded_amount: payment.amount,
        }).eq("id", payment.id)

        await supabase.from("payment_audit_log").insert({
          action: "refund_issued",
          payment_id: payment.id,
          details: { refund_id: refund.id, amount: payment.amount, refund_status: mappedStatus, event_id, triggered_by: "event_cancellation" },
        })

        // Organizer-cancelled events refund EVERYONE in full (fee included),
        // so the platform fee record for each transaction is zeroed.
        try {
          await rebalanceRefund(community, payment, "event_cancellation", event_id)
        } catch (clawbackErr) {
          await supabase.from("payment_audit_log").insert({
            action: "refund_wallet_debit_failed",
            payment_id: payment.id,
            details: {
              refund_id: refund.id,
              amount: payment.amount,
              reason: "event_cancellation",
              error: (clawbackErr as Error).message,
              note: "Customer refunded but organizer wallet clawback failed - manual follow-up required",
            },
          })
        }

        refunded++
      } catch (err) {
        console.error(`Refund failed for payment ${payment.id}:`, err)
        errors.push(`Payment ${payment.id}: ${(err as Error).message}`)
        await supabase.from("payments").update({ refund_status: "failed", refund_attempt_count: 1 }).eq("id", payment.id)
        await supabase.from("payment_audit_log").insert({
          action: "refund_failed",
          payment_id: payment.id,
          details: { error: String(err), event_id, triggered_by: "event_cancellation" },
        })
        failed++
      }
      // Always cancel the registration and decrement count
      await supabase.from("registrations").update({
        status: "cancelled",
        deleted_at: new Date().toISOString(),
      }).eq("id", payment.registration_id)

      await supabase.rpc("decrement_event_booked", { p_event_id: event_id })
    }

    const paidRegIds = new Set(payments.map(p => p.registration_id))
    for (const reg of confirmedRegs) {
      if (paidRegIds.has(reg.id)) continue
      await supabase.from("registrations").update({
        status: "cancelled",
        deleted_at: new Date().toISOString(),
      }).eq("id", reg.id)
      await supabase.rpc("decrement_event_booked", { p_event_id: event_id })
    }

    await supabase.from("events").update({ status: "cancelled" }).eq("id", event_id)

    await supabase.from("payment_audit_log").insert({
      action: "event_cancelled",
      details: { event_id, user_id: user.id, registrations_cancelled: confirmedRegs.length, payments_refunded: refunded, payments_failed: failed },
    })

    return new Response(JSON.stringify({
      success: true,
      registrations_cancelled: confirmedRegs.length,
      payments_refunded: refunded,
      payments_failed: failed,
      errors: errors.length > 0 ? errors : undefined,
    }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})