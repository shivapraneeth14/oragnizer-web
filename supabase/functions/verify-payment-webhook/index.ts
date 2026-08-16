import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { createHmac } from "node:crypto"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const RAZORPAY_WEBHOOK_SECRET = requiredEnv("RAZORPAY_WEBHOOK_SECRET")
const RAZORPAY_KEY_ID = requiredEnv("RAZORPAY_KEY_ID")
const RAZORPAY_KEY_SECRET = requiredEnv("RAZORPAY_KEY_SECRET")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const hmac = createHmac("sha256", secret)
  hmac.update(payload)
  const expected = hmac.digest("hex")
  return expected === signature
}

// Razorpay refund entity status -> our payments.refund_status domain.
const REFUND_STATUS_MAP: Record<string, string> = {
  created: "queued",
  pending: "pending",
  queued: "queued",
  initiated: "pending",
  processed: "processed",
  failed: "failed",
  cancelled: "failed",
}

async function processRefund(paymentId: string, amount: number) {
  const { data: payment } = await supabase.from("payments").select("id, razorpay_payment_id, amount, registration_id").eq("id", paymentId).single()
  if (!payment?.razorpay_payment_id) return

  const { data: registration } = await supabase.from("registrations").select("event_id, user_id").eq("id", payment.registration_id).single()

  let community: any = null
  let eventTitle: string | null = null
  if (registration) {
    const { data: event } = await supabase.from("events").select("community_id, title").eq("id", registration.event_id).single()
    if (event) {
      eventTitle = event.title
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
    const mappedStatus = REFUND_STATUS_MAP[refund.status] || "pending"

    await supabase.from("payments").update({
      status: "refunded",
      refund_status: mappedStatus,
      razorpay_refund_id: refund.id,
      refunded_amount: refund.amount,
    }).eq("id", paymentId)

    await supabase.from("payment_audit_log").insert({
      action: "refund_issued",
      payment_id: paymentId,
      details: { refund_id: refund.id, amount, reason: "capacity_full", refund_status: mappedStatus, event_id: registration?.event_id ?? null },
    })

    // Full refund to the customer — claw back the organizer's share and
    // zero the platform commission for this transaction. A failure here is
    // surfaced in payment_audit_log for manual follow-up; it must not block
    // the webhook ack (Razorpay redelivery would hit the duplicate-receipt
    // branch and never re-run the clawback).
    if (community) {
      const baseAmount = Number(payment.amount)
      const platformFee = Math.floor(baseAmount * Number(community.commission_percent) / 100)
      const organizerShare = baseAmount - platformFee
      const { data: debitResult, error: debitError } = await supabase.rpc("debit_wallet", {
        p_community_id: community.id,
        p_amount: organizerShare,
        p_reason: "capacity_full_refund",
        p_event_id: registration?.event_id ?? null,
      })
      if (debitError || debitResult?.error) {
        await supabase.from("payment_audit_log").insert({
          action: "refund_wallet_debit_failed",
          payment_id: paymentId,
          details: {
            refund_id: refund.id,
            amount,
            reason: "capacity_full",
            error: debitResult?.error || debitError?.message || "Wallet debit failed",
            note: "Customer refunded but organizer wallet clawback failed - manual follow-up required",
          },
        })
      } else if (platformFee > 0) {
        await supabase.from("payment_audit_log").insert({
          action: "commission_reversed",
          payment_id: paymentId,
          details: {
            commission_amount: platformFee,
            reason: "capacity_full",
            note: `Platform commission zeroed — customer refunded the full ₹${(Number(payment.amount) / 100).toFixed(0)} including our fee`,
          },
        })
      }
    }

    // Tell the customer their refund is on the way (capacity-full case).
    if (registration?.user_id) {
      await supabase.from("notifications").insert({
        user_id: registration.user_id,
        type: "refund_initiated",
        title: "Refund Initiated",
        body: `Refund of ₹${(Number(amount) / 100).toFixed(0)} for "${eventTitle ?? "your booking"}" is being processed.`,
        payload: { payment_id: paymentId, event_id: registration.event_id ?? null, amount, refund_id: refund.id },
      })
    }
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
      refund_status: "failed",
    }).eq("id", paymentId)

    await supabase.from("payment_audit_log").insert({
      action: "refund_failed",
      payment_id: paymentId,
      details: { error: errorDesc, razorpay_response: errBody, reason: "capacity_full" },
    })

    throw new Error(`Refund failed for payment ${paymentId}: ${errorDesc}`)
  }
}

// Keep payments.refund_status in sync with Razorpay refund webhooks so the
// reconcile retry job can see the real state (pending/failed/queued instead
// of a guessed "requested").
async function syncRefundState(entity: any, _eventType: string): Promise<void> {
  if (!entity?.id) return

  let { data: paymentRow } = await supabase
    .from("payments")
    .select("id, refund_attempt_count")
    .eq("razorpay_refund_id", entity.id)
    .maybeSingle()

  if (!paymentRow?.id && entity.payment_id) {
    const { data: byPayment } = await supabase
      .from("payments")
      .select("id, refund_attempt_count")
      .eq("razorpay_payment_id", entity.payment_id)
      .maybeSingle()
    paymentRow = byPayment
  }

  if (!paymentRow?.id) return

  const refundStatus = REFUND_STATUS_MAP[entity.status]
  if (!refundStatus) return

  const updates: Record<string, unknown> = {
    refund_status: refundStatus,
    razorpay_refund_id: entity.id,
  }
  if (refundStatus === "processed") {
    updates.status = "refunded"
    updates.refunded_amount = entity.amount
  } else if (refundStatus === "failed") {
    updates.refund_attempt_count = (paymentRow.refund_attempt_count ?? 0) + 1
  }

  await supabase.from("payments").update(updates).eq("id", paymentRow.id)

  await supabase.from("payment_audit_log").insert({
    action: "refund_status_synced",
    payment_id: paymentRow.id,
    details: { razorpay_refund_id: entity.id, razorpay_status: entity.status, refund_status: refundStatus },
  })

  // Money is back at the bank — tell the customer.
  if (refundStatus === "processed") {
    const { data: regRow } = await supabase
      .from("payments")
      .select("registration_id")
      .eq("id", paymentRow.id)
      .maybeSingle()
    const { data: reg } = regRow?.registration_id
      ? await supabase.from("registrations").select("user_id, event_id").eq("id", regRow.registration_id).maybeSingle()
      : { data: null }
    if (reg?.user_id) {
      await supabase.from("notifications").insert({
        user_id: reg.user_id,
        type: "refund_completed",
        title: "Refund Completed",
        body: `Refund of ₹${(Number(entity.amount ?? 0) / 100).toFixed(0)} has been credited back to your account.`,
        payload: { payment_id: paymentRow.id, event_id: reg.event_id ?? null, amount: entity.amount ?? null, refund_id: entity.id },
      })
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } })

  try {
    const body = await req.text()

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

    const eventType: string = payload.event
    const isCaptured = eventType === "payment.captured"
    const isRefundSync = eventType === "payment.refunded"
      || eventType === "refund.created"
      || eventType === "refund.pending"
      || eventType === "refund.queued"
      || eventType === "refund.initiated"
      || eventType === "refund.processed"
      || eventType === "refund.failed"
      || eventType === "refund.cancelled"

    if (!isCaptured && !isRefundSync) {
      return new Response("Unhandled event", { status: 200 })
    }

    // Webhook deduplication via processed_webhooks table
    const eventEntity = isCaptured
      ? payload.payload?.payment?.entity
      : (payload.payload?.refund?.entity ?? payload.payload?.payment?.entity)
    const eventIdFallback = eventEntity
      ? `${eventEntity.id}_${eventType}`.replaceAll("_", "")
      : `${Date.now()}_${eventType}`
    const razorpayEventId = req.headers.get("x-razorpay-event-id") || eventIdFallback
    const { data: dedupResult } = await supabase
      .rpc("try_process_webhook", {
        p_webhook_id: razorpayEventId,
        p_provider: "razorpay",
        p_event_type: eventType,
      })
    if (dedupResult === false) {
      return new Response("Already processed", { status: 200 })
    }

    if (isRefundSync) {
      await syncRefundState(eventEntity, eventType)
      return new Response("OK", { status: 200 })
    }

    const payment = eventEntity
    if (!payment?.order_id) return new Response("Missing order_id", { status: 400 })

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
