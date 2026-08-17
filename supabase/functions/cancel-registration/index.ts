import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const RAZORPAY_KEY_ID = requiredEnv("RAZORPAY_KEY_ID")
const RAZORPAY_KEY_SECRET = requiredEnv("RAZORPAY_KEY_SECRET")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

// Cancellations (with refund) close 24 hours before the event starts.
const CANCELLATION_WINDOW_MS = 24 * 60 * 60 * 1000

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

// Maps a Razorpay refund entity status into our payments.refund_status domain.
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

// Claw back the organizer's share from the community wallet. POLICY: on a
// customer self-cancellation the platform fee is NEVER refunded — only the
// organizer's share goes back to the customer, so there is no
// commission_reversed record here (unlike organizer-initiated cancellation,
// where the full amount is refunded and the fee record is zeroed).
async function rebalanceRefund(
  communityId: string,
  commissionPercent: number,
  payment: { id: string; amount: number },
  refundAmount: number,
  via: "registration_cancellation" | "event_cancellation",
  eventId: string,
) {
  const { data: debitResult, error: debitError } = await supabase.rpc("debit_wallet", {
    p_community_id: communityId,
    p_amount: refundAmount,
    p_reason: `${via}_refund`,
    p_event_id: eventId,
  })
  if (debitError || debitResult?.error) {
    throw new Error(debitResult?.error || debitError?.message || "Wallet debit failed")
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

    const rl = await checkRateLimit(user.id, "cancel-registration")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { event_id } = await req.json()
    if (!event_id) return new Response(JSON.stringify({ error: "Event ID required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: registration, error: findError } = await supabase
      .from("registrations")
      .select("id, event_id")
      .eq("event_id", event_id)
      .eq("user_id", user.id)
      .eq("status", "confirmed")
      .is("deleted_at", null)
      .maybeSingle()

    if (findError || !registration) return new Response(JSON.stringify({ error: "No active registration found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: eventInfo, error: eventError } = await supabase
      .from("events")
      .select("id, start_date, community_id, status, title")
      .eq("id", event_id)
      .single()

    if (eventError || !eventInfo) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (eventInfo.status === "cancelled") return new Response(JSON.stringify({ error: "Event has been cancelled" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })

    // Policy: customer self-cancellation (with refund) closes 24h before start.
    const startDate = new Date(eventInfo.start_date).getTime()
    const now = Date.now()
    if (now >= startDate - CANCELLATION_WINDOW_MS) {
      return new Response(JSON.stringify({
        error: "Cancellations close 24 hours before the event starts. Your registration stays confirmed — contact the organizer directly for help.",
        code: "cancellation_closed",
      }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: community, error: commError } = await supabase
      .from("communities")
      .select("id, commission_percent")
      .eq("id", eventInfo.community_id)
      .single()

    const commissionPercent = commError || !community ? 10 : Number(community.commission_percent)
    const payment = await supabase
      .from("payments")
      .select("id, status, razorpay_payment_id, amount")
      .eq("registration_id", registration.id)
      .maybeSingle()
      .then((r) => r.data)

    let refund: Record<string, unknown> = { initiated: false, reason: "no_payment" }

    if (payment && payment.status === "success" && payment.razorpay_payment_id) {
      try {
        // POLICY: customer self-cancellation refunds the organizer's share
        // only. The platform fee taken at confirm_payment is NOT refundable
        // on a self-cancel — it stays with the platform.
        const fee = Math.floor(Number(payment.amount) * commissionPercent / 100)
        const refundAmount = Number(payment.amount) - fee

        const refundRes = await razorpayPost(`payments/${payment.razorpay_payment_id}/refund`, { amount: refundAmount, receipt: `ref_${payment.id}` })

        const mappedStatus = mapRefundStatus(refundRes.status)

        // Record the truthful refund state FIRST (Razorpay accepted it), then
        // rebalance the wallet. A clawback failure is surfaced in the audit
        // log for manual follow-up instead of leaving a silently drifted row.
        await supabase.from("payments").update({
          status: "refunded",
          refund_status: mappedStatus,
          refund_attempt_count: 0,
          razorpay_refund_id: refundRes.id,
          refunded_amount: refundAmount,
        }).eq("id", payment.id)

        await supabase.from("payment_audit_log").insert({
          action: "refund_issued",
          payment_id: payment.id,
          details: { refund_id: refundRes.id, amount: refundAmount, refund_status: mappedStatus, registration_id: registration.id, event_id: eventInfo.id },
        })

        if (fee > 0) {
          await supabase.from("payment_audit_log").insert({
            action: "platform_fee_kept",
            payment_id: payment.id,
            details: {
              fee_amount: fee,
              reason: "customer_cancellation",
              note: `Customer self-cancelled — ₹${(fee / 100).toFixed(0)} platform fee kept, ₹${(refundAmount / 100).toFixed(0)} refunded`,
            },
          })
        }

        try {
          await rebalanceRefund(eventInfo.community_id, commissionPercent, payment, refundAmount, "registration_cancellation", eventInfo.id)
        } catch (clawbackErr) {
          await supabase.from("payment_audit_log").insert({
            action: "refund_wallet_debit_failed",
            payment_id: payment.id,
            details: {
              refund_id: refundRes.id,
              amount: refundAmount,
              reason: "registration_cancellation",
              error: (clawbackErr as Error).message,
              note: "Customer refunded but organizer wallet clawback failed - manual follow-up required",
            },
          })
        }

        await supabase.from("notifications").insert({
          user_id: user.id,
          type: "refund_initiated",
          title: "Refund Initiated",
          body: `Refund of ₹${(refundAmount / 100).toFixed(0)} for "${eventInfo.title}" has been initiated. ₹${(fee / 100).toFixed(0)} booking fee is not refundable.`,
          payload: {
            event_id: eventInfo.id,
            payment_id: payment.id,
            registration_id: registration.id,
            amount: refundAmount,
            fee_kept: fee,
          },
        })

        refund = { initiated: true, amount: refundAmount, fee_kept: fee, refund_id: refundRes.id, status: mappedStatus }
      } catch (refundErr) {
        console.error("Refund failed:", refundErr)
        await supabase.from("payments").update({ refund_status: "failed", refund_attempt_count: 1 }).eq("id", payment.id)
        await supabase.from("payment_audit_log").insert({
          action: "refund_failed",
          payment_id: payment.id,
          details: { error: String(refundErr) },
        })
        refund = { initiated: false, reason: "failed" }
      }
    }

    // Cancel registration regardless of refund outcome
    await supabase.from("registrations").update({
      status: "cancelled",
      qr_code: null,
      deleted_at: new Date().toISOString(),
    }).eq("id", registration.id)

    await supabase.rpc("decrement_event_booked", { p_event_id: event_id })

    return new Response(JSON.stringify({ success: true, refund }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})