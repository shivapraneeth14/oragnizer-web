import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { attemptRefund, razorpayGet } from "../_shared/refunds.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
}

// Organizer-initiated cancellation refunds EVERY non-attended registration in
// FULL (customer gets the complete amount back, platform fee included). The
// organizer's wallet is debited by their share only (inside the refund claim
// RPC, exactly once); the platform's commission record for the transaction is
// zeroed via commission_reversed. Refund issuance is claim-guarded by
// _shared/refunds.attemptRefund, so concurrent callers cannot double-refund.
//
// Attendees who already attended are NEVER refunded, at any time — they
// consumed the ticket. Their registration stays 'attended' as the attendance
// record and their payment stays untouched (no clawback, no refund).

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
      .select("id, owner_id")
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
      .select("id, user_id, status")
      .eq("event_id", event_id)
      .is("deleted_at", null)

    const liveRegs = registrations || []

    let payments: any[] = []
    if (liveRegs.length > 0) {
      const { data: p } = await supabase
        .from("payments")
        .select("id, amount, razorpay_payment_id, razorpay_order_id, registration_id, status, platform_fee, organizer_share")
        .in("registration_id", liveRegs.map(r => r.id))
      payments = p || []
    }

    // Rescue sweep: a payment can sit "pending" locally while its money is
    // already captured at Razorpay (webhook delay). Ask Razorpay directly so
    // paid attendees are never stranded without a refund when the event dies.
    const rescuedRegIds = new Set<string>()
    const alreadyPaidRegIds = new Set(payments.filter(p => p.status === "success").map(p => p.registration_id))
    for (const payment of payments.filter(p => p.status === "pending" && p.razorpay_order_id && !alreadyPaidRegIds.has(p.registration_id))) {
      if (rescuedRegIds.has(payment.registration_id)) continue
      try {
        const order = await razorpayGet(`orders/${payment.razorpay_order_id}`)
        if (order.status !== "paid" || (order.amount_paid || 0) <= 0) continue

        const payBody = await razorpayGet(`orders/${payment.razorpay_order_id}/payments`)
        const captured = payBody?.items?.find((p: any) => p.status === "captured")
        if (!captured) continue

        const { error: updateErr } = await supabase.from("payments").update({ razorpay_payment_id: captured.id }).eq("id", payment.id)
        if (updateErr) throw updateErr

        // confirm_payment is idempotent and keeps the wallet/transfer ledger
        // correct (books capacity, credits organizer share).
        const { data: confirmResult, error: confirmErr } = await supabase.rpc("confirm_payment", { p_payment_id: payment.id })
        if (confirmErr) throw confirmErr
        if (confirmResult?.error) throw new Error(confirmResult.error)

        payment.status = "success"
        payment.razorpay_payment_id = captured.id
        rescuedRegIds.add(payment.registration_id)
        const reg = liveRegs.find(r => r.id === payment.registration_id)
        if (reg && reg.status !== "confirmed") reg.status = "confirmed"
      } catch (err) {
        console.error(`Pending-payment sweep failed for ${payment.id}:`, err)
        await supabase.from("payment_audit_log").insert({
          action: "pending_sweep_failed",
          payment_id: payment.id,
          details: { error: String(err), event_id, triggered_by: "event_cancellation" },
        })
      }
    }

    const attendedRegIds = new Set<string>(
      (liveRegs || []).filter(r => r.status === "attended").map(r => r.id),
    )

    let refunded = 0
    let failed = 0
    let refundsSkipped = 0
    const errors: string[] = []

    // Attendees who already attended keep their ticket and their money — never
    // refunded, even though the event is cancelled.
    for (const payment of payments.filter(p => p.status === "success" && attendedRegIds.has(p.registration_id))) {
      refundsSkipped++
      await supabase.from("payment_audit_log").insert({
        action: "refund_skipped_attended",
        payment_id: payment.id,
        details: {
          event_id,
          registration_id: payment.registration_id,
          note: "Attendee already attended — no refund on event cancellation",
        },
      })
    }

    const refundable = payments.filter(p => p.status === "success" && !attendedRegIds.has(p.registration_id))

    // Every refundable paid registration gets a full refund. Claims
    // serialize concurrent refund attempts on each payment exactly once.
    for (const payment of refundable) {
      try {
        const outcome = await attemptRefund(supabase, payment, payment.amount, "event_cancellation")

        if (outcome.status === "conflict") {
          await supabase.from("payment_audit_log").insert({
            action: "refund_conflict",
            payment_id: payment.id,
            details: { event_id, note: "Refund skipped — another flow already holds the claim on this payment" },
          })
        } else if (outcome.status === "already_refunded") {
          await supabase.from("payment_audit_log").insert({
            action: "refund_already_processed",
            payment_id: payment.id,
            details: { refund_id: outcome.refund_id, event_id, triggered_by: "event_cancellation" },
          })
          refunded++
        } else {
          // Organizer-cancelled events refund EVERYONE in full (fee included),
          // so the platform fee record for each transaction is zeroed. The
          // wallet clawback itself already ran inside complete_payment_refund.
          const platformFee = Math.max(Number(payment.platform_fee ?? 0), 0)
          if (platformFee > 0) {
            await supabase.from("payment_audit_log").insert({
              action: "commission_reversed",
              payment_id: payment.id,
              details: {
                commission_amount: platformFee,
                reason: "event_cancellation",
                note: `Platform commission zeroed — customer refunded the full ₹${(Number(payment.amount) / 100).toFixed(0)} including our fee`,
              },
            })
          }
          refunded++
        }
      } catch (err) {
        console.error(`Refund failed for payment ${payment.id}:`, err)
        errors.push(`Payment ${payment.id}: ${(err as Error).message}`)
        await supabase.from("payment_audit_log").insert({
          action: "refund_failed",
          payment_id: payment.id,
          details: { error: String(err), event_id, triggered_by: "event_cancellation" },
        })
        failed++
      }
      // Always cancel the registration and release capacity. The RPC only
      // decrements when the registration was confirmed (pending regs were
      // never counted), inside one transaction — atomic + exactly-once.
      await supabase.rpc("cancel_registration_and_decrement", {
        p_registration_id: payment.registration_id,
        p_deleted_at: new Date().toISOString(),
      })
    }

    const refundedRegIds = new Set(refundable.map(p => p.registration_id))
    for (const reg of liveRegs) {
      if (refundedRegIds.has(reg.id)) continue
      if (attendedRegIds.has(reg.id)) continue
      // Cancel + release capacity in one transaction; decrements only when
      // the registration was confirmed (so it was actually counted), exactly
      // once even if two cancel flows race on the same registration.
      await supabase.rpc("cancel_registration_and_decrement", {
        p_registration_id: reg.id,
        p_deleted_at: new Date().toISOString(),
      })
    }

    await supabase.from("events").update({ status: "cancelled" }).eq("id", event_id)

    await supabase.from("payment_audit_log").insert({
      action: "event_cancelled",
      details: { event_id, user_id: user.id, registrations_cancelled: liveRegs.length, payments_refunded: refunded, payments_failed: failed, refunds_skipped_attended: refundsSkipped },
    })

    return new Response(JSON.stringify({
      success: true,
      registrations_cancelled: liveRegs.length,
      payments_refunded: refunded,
      payments_failed: failed,
      refunds_skipped_attended: refundsSkipped,
      errors: errors.length > 0 ? errors : undefined,
    }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})