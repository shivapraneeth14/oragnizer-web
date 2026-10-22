import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { attemptRefund } from "../_shared/refunds.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

// Cancellations (with refund) close 24 hours before the event starts.
const CANCELLATION_WINDOW_MS = 24 * 60 * 60 * 1000

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
}

// Claw back the organizer's share from the community wallet. POLICY: on a
// customer self-cancellation the platform fee is NEVER refunded — only the
// organizer's share goes back to the customer, so there is no
// commission_reversed record here (unlike organizer-initiated cancellation,
// where the full amount is refunded and the fee record is zeroed).
// `refundAmount` IS the organizer share (amount − persisted platform fee).
// The clawback itself runs inside the refund-claim RPC (exactly once).

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

    const { event_id, policy_acknowledged } = await req.json()
    if (!event_id) return new Response(JSON.stringify({ error: "Event ID required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: registration, error: findError } = await supabase
      .from("registrations")
      .select("id, event_id, status")
      .eq("event_id", event_id)
      .eq("user_id", user.id)
      .in("status", ["confirmed", "pending"])
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

    // The split (fee vs ticket) was persisted when the order was created —
    // read it; never re-derive money from commission_percent.
    const payment = await supabase
      .from("payments")
      .select("id, status, razorpay_payment_id, amount, platform_fee")
      .eq("registration_id", registration.id)
      .maybeSingle()
      .then((r) => r.data)

    if (registration.status === "pending") {
      // A pending booking is only cancellable when the money was actually
      // captured (webhook lost / confirm never ran) — otherwise the user is
      // mid-checkout and the cancel is meaningless.
      const canCancelPending = payment?.status === "success" && !!payment.razorpay_payment_id
      if (!canCancelPending) {
        return new Response(JSON.stringify({ error: "No active registration found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
      }
    }

    let refund: Record<string, unknown> = { initiated: false, reason: "no_payment" }

    // Audit the client's cancellation-policy acknowledgment (the mobile app
    // requires a ticked "I understand the cancellation and refund policy"
    // checkbox before enabling Confirm). Optional on purpose: released app
    // builds that predate the checkbox still cancel exactly as before.
    if (typeof policy_acknowledged === "boolean") {
      if (payment) {
        await supabase.from("payment_audit_log").insert({
          action: "cancellation_policy_ack",
          payment_id: payment.id,
          details: { acknowledged: policy_acknowledged, registration_id: registration.id },
        })
      } else {
        await supabase.from("audit_log").insert({
          actor_id: user.id,
          action: "cancellation_policy_ack",
          target_type: "registration",
          target_id: registration.id,
          details: { acknowledged: policy_acknowledged },
        })
      }
    }

    // ORDER MATTERS: cancel the registration FIRST (one transaction — the RPC
    // only decrements booked_count when the registration actually transitioned
    // confirmed -> cancelled, so concurrent cancels can never double-release),
    // THEN issue the refund. The old order (refund first) left a window where
    // the payment could be refunded while the registration was still
    // confirmed — a concurrent payment capture in that window ended up paid
    // with no recoverable booking. If the refund fails here, the claim is
    // released as 'failed' and the reconcile retry job re-issues it later
    // using the persisted refund_amount_due (never re-deriving the policy).
    await supabase.rpc("cancel_registration_and_decrement", {
      p_registration_id: registration.id,
      p_deleted_at: new Date().toISOString(),
    })

    if (payment && payment.status === "success" && payment.razorpay_payment_id) {
      try {
        // POLICY: customer self-cancellation refunds the ticket only — the
        // platform fee (flat fee + GST, persisted at order creation) is
        // NOT refundable on a self-cancel; it stays with the platform.
        const fee = Math.max(Number(payment.platform_fee ?? 0), 0)
        const refundAmount = Math.max(Number(payment.amount) - fee, 0)

        const outcome = await attemptRefund(supabase, payment, refundAmount, "registration_cancellation")

        if (outcome.status === "conflict") {
          await supabase.from("payment_audit_log").insert({
            action: "refund_conflict",
            payment_id: payment.id,
            details: { note: "Refund skipped — another flow already holds the claim on this payment" },
          })
          refund = { initiated: false, reason: "in_flight" }
        } else if (outcome.status === "already_refunded") {
          refund = { initiated: true, amount: refundAmount, fee_kept: fee, refund_id: outcome.refund_id, status: outcome.refund_status }
        } else {
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

          refund = { initiated: true, amount: refundAmount, fee_kept: fee, refund_id: outcome.refund_id, status: outcome.refund_status }
        }
      } catch (refundErr) {
        console.error("Refund failed:", refundErr)
        await supabase.from("payment_audit_log").insert({
          action: "refund_failed",
          payment_id: payment.id,
          details: { error: String(refundErr), note: "Registration already cancelled — reconcile will retry the refund" },
        })
        refund = { initiated: false, reason: "failed" }
      }
    }

    return new Response(JSON.stringify({ success: true, refund }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})