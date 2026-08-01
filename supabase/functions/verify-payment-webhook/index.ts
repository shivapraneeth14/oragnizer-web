import { createClient } from "jsr:@supabase/supabase-js@2"
import { createHmac } from "node:crypto"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const RAZORPAY_WEBHOOK_SECRET = Deno.env.get("RAZORPAY_WEBHOOK_SECRET")!
const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID")!
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET")!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const hmac = createHmac("sha256", secret)
  hmac.update(payload)
  const expected = hmac.digest("hex")
  return expected === signature
}

async function processRefund(paymentId: string, amount: number) {
  const { data: payment } = await supabase.from("payments").select("id, razorpay_payment_id, amount, registration_id").eq("id", paymentId).single()
  if (!payment?.razorpay_payment_id) return

  const { data: registration } = await supabase.from("registrations").select("event_id").eq("id", payment.registration_id).single()

  let community: any = null
  if (registration) {
    const { data: event } = await supabase.from("events").select("community_id").eq("id", registration.event_id).single()
    if (event) {
      const { data: c } = await supabase.from("communities").select("id, commission_percent, commission_on").eq("id", event.community_id).single()
      community = c
    }
  }

  const res = await fetch(`https://api.razorpay.com/v1/payments/${payment.razorpay_payment_id}/refund`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
    },
    body: JSON.stringify({ amount, receipt: `ref_${paymentId}` }),
  })

  if (res.ok) {
    const refund = await res.json()

    if (community) {
      const baseAmount = Number(payment.amount)
      const platformFee = Math.floor(baseAmount * Number(community.commission_percent) / 100)
      const organizerShare = baseAmount - platformFee
      await supabase.rpc("debit_wallet", {
        p_community_id: community.id,
        p_amount: organizerShare,
        p_reason: "capacity_full_refund",
      })
    }

    await supabase.from("payments").update({
      status: "refunded",
      refund_status: "processed",
      razorpay_refund_id: refund.id,
      refunded_amount: refund.amount,
    }).eq("id", paymentId)

    await supabase.from("payment_audit_log").insert({
      action: "refund_issued",
      payment_id: paymentId,
      details: { refund_id: refund.id, amount, reason: "capacity_full" },
    })
  } else {
    const errBody = await res.json().catch(() => ({ error: { description: "Unknown Razorpay error" } }))
    const errorDesc = errBody.error?.description || errBody.message || `HTTP ${res.status}`

    const errCode = errBody.error?.code || ""
    const alreadyProcessed = errCode === "BAD_REQUEST_ERROR"
      && /duplicate\s+receipt/i.test(errorDesc)

    if (alreadyProcessed) {
      await supabase.from("payment_audit_log").insert({
        action: "refund_already_processed",
        payment_id: paymentId,
        details: { razorpay_response: errBody, reason: "capacity_full" },
      })
      return
    }

    await supabase.from("payments").update({
      refund_status: "requested",
    }).eq("id", paymentId)

    await supabase.from("payment_audit_log").insert({
      action: "refund_failed",
      payment_id: paymentId,
      details: { error: errorDesc, razorpay_response: errBody, reason: "capacity_full" },
    })

    throw new Error(`Refund failed for payment ${paymentId}: ${errorDesc}`)
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } })

  try {
    const body = await req.text()
    const ip = getClientIp(req)
    const rl = await checkRateLimit(ip, "verify-payment-webhook")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const signature = req.headers.get("x-razorpay-signature")
    if (!signature) return new Response("Missing signature", { status: 401 })

    // Verify HMAC
    if (!await verifySignature(body, signature, RAZORPAY_WEBHOOK_SECRET)) {
      return new Response("Invalid signature", { status: 401 })
    }

    const payload = JSON.parse(body)

    // Replay protection — reject webhooks older than 5 minutes
    if (payload.created_at) {
      const webhookTime = new Date(payload.created_at * 1000)
      const age = Date.now() - webhookTime.getTime()
      if (age > 5 * 60 * 1000) {
        return new Response("Webhook too old", { status: 400 })
      }
    }

    // Only handle payment.captured
    if (payload.event !== "payment.captured") {
      return new Response("Unhandled event", { status: 200 })
    }

    const payment = payload.payload?.payment?.entity
    if (!payment?.order_id) return new Response("Missing order_id", { status: 400 })

    // Webhook deduplication via processed_webhooks table
    const razorpayEventId = req.headers.get("x-razorpay-event-id") || `rzp_${payment.id}_${payment.order_id}`
    const { data: dedupResult } = await supabase
      .rpc("try_process_webhook", {
        p_webhook_id: razorpayEventId,
        p_provider: "razorpay",
        p_event_type: payload.event,
      })
    if (dedupResult === false) {
      return new Response("Already processed", { status: 200 })
    }

    // Find payments row by razorpay_order_id
    const { data: paymentRow } = await supabase
      .from("payments")
      .select("id, status")
      .eq("razorpay_order_id", payment.order_id)
      .maybeSingle()

    if (!paymentRow) {
      return new Response("Order not found", { status: 404 })
    }

    // Idempotency — already processed
    if (paymentRow.status === "success") {
      return new Response("Already processed", { status: 200 })
    }

    // Update payment with razorpay_payment_id
    await supabase.from("payments").update({
      razorpay_payment_id: payment.id,
    }).eq("id", paymentRow.id)

    // Run confirm_payment RPC (atomic transaction)
    const { data: confirmResult, error: confirmErr } = await supabase
      .rpc("confirm_payment", { p_payment_id: paymentRow.id })

    if (confirmErr) throw confirmErr

    if (confirmResult?.action === "refund_required") {
      try {
        await processRefund(paymentRow.id, payment.amount)
        return new Response("Refund issued", { status: 200 })
      } catch (refundErr) {
        console.error("Auto-refund failed:", refundErr)
        return new Response("Refund failed, manual intervention required", { status: 200 })
      }
    }

    if (confirmResult?.error) {
      throw new Error(confirmResult.error)
    }

    return new Response("OK", { status: 200 })
  } catch (err) {
    console.error("verify-payment-webhook error:", err)
    return new Response("Internal error", { status: 500 })
  }
})
