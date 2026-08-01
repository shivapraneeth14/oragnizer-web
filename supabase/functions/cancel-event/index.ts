import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID")!
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET")!
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
      .select("id, community_id, status")
      .eq("id", event_id)
      .single()

    if (eventErr || !event) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.status === "cancelled") return new Response(JSON.stringify({ error: "Event already cancelled" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: community } = await supabase
      .from("communities")
      .select("id, owner_id, wallet_balance, commission_percent")
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

    for (const payment of payments) {
      let paymentRefunded = false
      try {
        if (payment.razorpay_payment_id) {
          const refund = await razorpayPost(`payments/${payment.razorpay_payment_id}/refund`, { amount: payment.amount })

          if (community) {
            const platformFee = Math.floor(Number(payment.amount) * Number(community.commission_percent) / 100)
            const organizerShare = Number(payment.amount) - platformFee
            const { data: debitResult, error: debitError } = await supabase.rpc("debit_wallet", {
              p_community_id: community.id,
              p_amount: organizerShare,
              p_reason: "event_cancellation_refund",
            })
            if (debitError || debitResult?.error) {
              throw new Error(debitResult?.error || debitError?.message || "Wallet debit failed")
            }
          }

          await supabase.from("payments").update({
            status: "refunded",
            refund_status: "processed",
            razorpay_refund_id: refund.id,
            refunded_amount: payment.amount,
          }).eq("id", payment.id)

          await supabase.from("payment_audit_log").insert({
            action: "refund_issued",
            payment_id: payment.id,
            details: { refund_id: refund.id, amount: payment.amount, event_id, triggered_by: "event_cancellation" },
          })

          refunded++
          paymentRefunded = true
        }
      } catch (err) {
        console.error(`Refund failed for payment ${payment.id}:`, err)
        errors.push(`Payment ${payment.id}: ${(err as Error).message}`)
        await supabase.from("payments").update({ refund_status: "requested" }).eq("id", payment.id)
        await supabase.from("payment_audit_log").insert({
          action: "refund_failed",
          payment_id: payment.id,
          details: { error: String(err), event_id, triggered_by: "event_cancellation" },
        })
        failed++
        // Still cancel the registration and decrement count
        paymentRefunded = true
      }

      // Always cancel registration and decrement booked_count for processed payments,
      // regardless of whether the refund succeeded or failed
      if (paymentRefunded || payment.razorpay_payment_id) {
        await supabase.from("registrations").update({
          status: "cancelled",
          deleted_at: new Date().toISOString(),
        }).eq("id", payment.registration_id)

        await supabase.rpc("decrement_event_booked", { p_event_id: event_id })
      }
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
