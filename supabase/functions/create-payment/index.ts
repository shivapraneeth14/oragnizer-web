import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { platformFeeForTicket } from "../_shared/fees.ts"
import { hasConsentRecord } from "../_shared/consent.ts"
import {
  clearRefundFieldsForRequote,
  paymentNonRequotableReason,
  restoreRegistrationIfCancelled,
  revertRegistrationToCancelled,
} from "../_shared/payments.ts"
import { attemptRefund, customerOwedAmount } from "../_shared/refunds.ts"
import { isDeletionPending, deletionPendingResponse } from "../_shared/deletion.ts"

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

async function createRazorpayOrder(amount: number, registrationId: string) {
  // Key includes the receipt (registration + attempt) so a re-quote with a
  // different amount can never be answered with the stale order.
  const idempotencyKey = `order_${registrationId}`
  const body: any = { amount, currency: "INR", receipt: registrationId }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
        "X-Razorpay-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { description: "Razorpay request failed" } }))
      throw new Error(err.error?.description || `Razorpay error (${res.status})`)
    }
    const result = await res.json()
    if (!result || !result.id) {
      throw new Error("Razorpay returned an invalid order response")
    }
    return result
  } finally {
    clearTimeout(timeout)
  }
}

async function razorpayGet(path: string): Promise<any> {
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { description: `HTTP ${res.status}` } }))
    throw new Error(err.error?.description || `Razorpay error (${res.status})`)
  }
  return res.json()
}

// "Path C": if the pending order is actually paid and captured, CONFIRM the
// registration (money already moved) instead of reusing a dead order.
async function confirmPaidOrder(paymentId: string, orderId: string): Promise<{ confirmed: boolean } | null> {
  try {
    const order = await razorpayGet(`orders/${orderId}`)
    if (order.status !== "paid" || (order.amount_paid || 0) <= 0) return null

    const payBody = await razorpayGet(`orders/${orderId}/payments`)
    const captured = payBody?.items?.find((p: any) => p.status === "captured")
    if (!captured) return null

    const { error: updateErr } = await supabase.from("payments").update({ razorpay_payment_id: captured.id }).eq("id", paymentId)
    if (updateErr) throw updateErr
    const { data: confirmResult, error: confirmErr } = await supabase
      .rpc("confirm_payment", { p_payment_id: paymentId })
    if (confirmErr) throw confirmErr
    if (confirmResult?.error) throw new Error(confirmResult.error)
    if (confirmResult?.action === "refund_required") return { confirmed: false }
    return { confirmed: true }
  } catch (err) {
    console.error(`confirmPaidOrder failed for payment ${paymentId}:`, err)
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const token = authHeader.replace("Bearer ", "")
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const rl = await checkRateLimit(user.id, "create-payment")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    // Server-side consent backstop: no payment without a recorded policy
    // consent (see _shared/consent.ts). Version re-prompting is the client
    // consent gate's job — any recorded version satisfies this check.
    if (!(await hasConsentRecord(supabase, user.id))) {
      return new Response(JSON.stringify({ error: "Please accept the Privacy Policy and Terms of Service to continue." }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    if (await isDeletionPending(supabase, user.id)) return deletionPendingResponse()

    const { event_id, coupon_code } = await req.json()
    if (!event_id) return new Response(JSON.stringify({ error: "event_id is required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: event, error: eventErr } = await supabase
      .from("events")
      .select("id, price, status, deleted_at, capacity, booked_count, title, community_id, start_date")
      .eq("id", event_id)
      .single()

    if (eventErr || !event) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.deleted_at) return new Response(JSON.stringify({ error: "Event has been deleted" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.status === "cancelled") return new Response(JSON.stringify({ error: "Event has been cancelled" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.status === "completed") return new Response(JSON.stringify({ error: "Event has ended" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.status !== "published") return new Response(JSON.stringify({ error: "Event is not available" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.start_date && new Date(event.start_date) < new Date()) return new Response(JSON.stringify({ error: "Event has already started" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.capacity !== null && event.booked_count >= event.capacity) return new Response(JSON.stringify({ error: "Event is full" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.price <= 0) return new Response(JSON.stringify({ error: "Event is free" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: community } = await supabase
      .from("communities")
      .select("id, commission_percent")
      .eq("id", event.community_id)
      .maybeSingle()

    const { data: existing } = await supabase
      .from("registrations")
      .select("id, status")
      .eq("event_id", event_id)
      .eq("user_id", user.id)
      .maybeSingle()

    const { data: existingPayment } = existing
      ? await supabase
          .from("payments")
          .select("id, razorpay_order_id, razorpay_payment_id, status, refund_status, refund_claim_state, refund_amount_due, refund_reason, refund_attempt_count, platform_fee, created_at, attempt_count, amount")
          .eq("registration_id", existing.id)
          .maybeSingle()
      : { data: null }

    // --- State-machine gate: a paid (or refunding) payment row must never be
    // demoted to pending, and a cancelled registration holding one must never
    // be resurrected. Check BEFORE any write.
    if (existingPayment) {
      let blockReason = paymentNonRequotableReason(existingPayment)

      // P3b recovery: a FAILED customer-cancellation refund must not lock the
      // customer out of rebooking forever ("already paid" while they hold no
      // booking and no money). Retry the outstanding refund on the spot at
      // the PERSISTED owed amount (ticket only — platform fee kept), using
      // the persisted cancellation type. Only customer-policy rows qualify;
      // organizer-policy failures are retried by reconcile at full amount.
      if (
        blockReason === "already_paid" &&
        existing?.status === "cancelled" &&
        existingPayment.refund_status === "failed" &&
        existingPayment.refund_claim_state !== "claimed" &&
        existingPayment.razorpay_payment_id &&
        (!existingPayment.refund_reason || existingPayment.refund_reason === "registration_cancellation")
      ) {
        const owed = existingPayment.refund_amount_due != null
          ? Number(existingPayment.refund_amount_due)
          : customerOwedAmount(existingPayment)
        try {
          // Claim-guarded exactly like every other refund path: if another
          // flow holds the claim we get a clean conflict, never a double
          // refund. On success/conflict the gate below re-evaluates on the
          // fresh row state.
          await attemptRefund(supabase, existingPayment, owed, existingPayment.refund_reason ?? "registration_cancellation")
        } catch (retryErr) {
          console.error("On-demand refund retry failed:", retryErr)
          // Still blocked — the clear message below tells the customer what
          // is happening; reconcile keeps retrying in the background.
        }
        const { data: refreshed } = await supabase
          .from("payments")
          .select("id, status, refund_status, refund_claim_state")
          .eq("id", existingPayment.id)
          .maybeSingle()
        if (refreshed) blockReason = paymentNonRequotableReason(refreshed)
      }

      if (blockReason) {
        const message = blockReason === "already_paid"
          ? "You have already paid for this event."
          : "A refund for your previous booking is being processed. You can rebook once it completes — we'll notify you."
        return new Response(JSON.stringify({ error: message, code: blockReason }), {
          status: 409,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
    }

    const amount = event.price
    let ticket = amount
    let pendingCouponId: string | null = null

    if (coupon_code) {
      const { data: coupon } = await supabase
        .from("coupons")
        .select("id, discount_type, discount_value, valid_until")
        .eq("code", coupon_code)
        .eq("community_id", event.community_id)
        .maybeSingle()

      if (!coupon) {
        return new Response(JSON.stringify({ error: "Invalid coupon code" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
      }

      if (coupon.valid_until && new Date(coupon.valid_until) < new Date()) {
        return new Response(JSON.stringify({ error: "Coupon has expired" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
      }

      // Clamp server-side so a malformed coupon row can never over-discount.
      let discount = 0
      if (coupon.discount_type === "percentage") {
        const pct = Math.min(Math.max(Number(coupon.discount_value) || 0, 0), 100)
        discount = Math.floor(amount * pct / 100)
      } else {
        discount = Math.max(Math.min(Number(coupon.discount_value) || 0, amount), 0)
      }

      ticket = Math.max(amount - discount, 0)
      pendingCouponId = coupon.id
    }

    if (ticket <= 0) {
      return new Response(JSON.stringify({ error: "Coupon covers the full ticket. Register for free instead." }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }
    // Fee-on-top: charge = ticket + commission_percent of ticket (no GST).
    // Split persisted once, at order creation; confirm_payment reads it back.
    const fee = platformFeeForTicket(ticket, community?.commission_percent)
    const finalAmount = ticket + fee.total

    // --- Reuse a valid in-flight order (Path C: if the money already landed,
    // confirm instead of reusing — the success callback may have been lost).
    if (existingPayment && existingPayment.status === "pending" && existingPayment.razorpay_order_id) {
      const orderAge = Date.now() - new Date(existingPayment.created_at).getTime()
      // Only reuse the order if it was quoted at today's math (fee or price
      // may have changed since) — otherwise fall through and re-quote.
      const reusable = orderAge < 24 * 60 * 60 * 1000 && Number(existingPayment.amount) === finalAmount
      if (reusable) {
        const confirmed = await confirmPaidOrder(existingPayment.id, existingPayment.razorpay_order_id)
        if (confirmed?.confirmed) {
          return new Response(JSON.stringify({ exists: true, payment_status: "confirmed", registration_id: existing!.id }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
        if (confirmed !== null) {
          return new Response(JSON.stringify({ error: "Your payment was received but could not be confirmed. Payment will be refunded." }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
        // Order usable, not paid yet. Restore a cancelled booking ONLY here —
        // never before this point (the payment row may still be paid/refunding).
        await restoreRegistrationIfCancelled(supabase, existing!.id)
        return new Response(JSON.stringify({ registration_id: existing!.id, razorpay_order_id: existingPayment.razorpay_order_id, amount: finalAmount, platform_fee: fee.total, platform_fee_gst: fee.gst, ticket_price: ticket }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
      }
    }

    // Atomically reserve a use ONLY when a new order will be created.
    let registrationId: string
    if (existing) {
      registrationId = existing.id
    } else {
      const { data: reg, error: regErr } = await supabase
        .from("registrations")
        .insert({ event_id, user_id: user.id, status: "pending" })
        .select("id")
        .single()
      if (regErr) throw regErr
      registrationId = reg!.id
    }

    let couponId: string | null = null
    if (pendingCouponId) {
      const { data: claimResult } = await supabase
        .rpc("claim_coupon", { p_coupon_id: pendingCouponId })
      if (!claimResult?.claimed) {
        return new Response(JSON.stringify({ error: "Coupon code has reached its usage limit" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
      }
      couponId = pendingCouponId
    }

    const attemptCount = (existingPayment?.attempt_count ?? 0) + 1

    // From here any failure releases the claim — a rejected or crashed order
    // must never permanently burn a coupon use. A cancelled registration is
    // restored to pending only AFTER the order exists, and reverted if the
    // payment row cannot be persisted.
    try {
      const order = await createRazorpayOrder(finalAmount, `${registrationId}_${attemptCount}`)
      await restoreRegistrationIfCancelled(supabase, registrationId)

      try {
        if (existingPayment) {
          // An old refunded/failed sale on this row is being replaced by a new
          // order — archive + clear the stale refund fields first.
          await clearRefundFieldsForRequote(supabase, existingPayment)
          const { error: updateError } = await supabase
            .from("payments")
            .update({
              razorpay_order_id: order.id,
              status: "pending",
              amount: finalAmount,
              platform_fee: fee.total,
              platform_fee_gst: null,
              coupon_id: couponId,
              attempt_count: attemptCount,
              created_at: new Date().toISOString(),
            })
            .eq("id", existingPayment.id)
          if (updateError) throw updateError
        } else {
          const { data: newPayment, error: insertError } = await supabase
            .from("payments")
            .insert({
              registration_id: registrationId,
              amount: finalAmount,
              platform_fee: fee.total,
              platform_fee_gst: null,
              razorpay_order_id: order.id,
              status: "pending",
              coupon_id: couponId,
              attempt_count: attemptCount,
            })
            .select("id")
            .single()
          if (insertError) throw insertError
          if (!newPayment) throw new Error("Failed to create payment record")
        }
      } catch (err) {
        // Payment row could not be persisted for the freshly-created order —
        // the booking must not stay pending with no live payment behind it.
        await revertRegistrationToCancelled(supabase, registrationId)
        throw err
      }

      return new Response(JSON.stringify({ registration_id: registrationId, razorpay_order_id: order.id, amount: finalAmount, platform_fee: fee.total, platform_fee_gst: fee.gst, ticket_price: ticket }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    } catch (err: any) {
      if (err?.code === "23505") {
        // Concurrent double-tap: another request won the payment row. Release
        // THIS call's claim — the winner's claim is the one tied to the row.
        try {
          if (couponId) await supabase.rpc("release_coupon", { p_coupon_id: couponId })
        } catch { /* best-effort */ }
        const { data: recovered } = await supabase
          .from("payments")
          .select("id, razorpay_order_id, status, refund_status, refund_claim_state")
          .eq("registration_id", registrationId)
          .single()
        if (recovered) {
          const winnerBlock = paymentNonRequotableReason(recovered)
          if (winnerBlock === "already_paid") {
            return new Response(JSON.stringify({ exists: true, payment_status: "confirmed", registration_id: registrationId }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
          }
          if (winnerBlock) {
            return new Response(JSON.stringify({ error: "Your payment is being refunded. You cannot pay again.", code: winnerBlock }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
          }
          return new Response(JSON.stringify({ registration_id: registrationId, razorpay_order_id: recovered.razorpay_order_id, amount: finalAmount, platform_fee: fee.total, platform_fee_gst: fee.gst, ticket_price: ticket }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
      // Any other failure (provider, insert) → release the claim, then rethrow.
      try {
        if (couponId) await supabase.rpc("release_coupon", { p_coupon_id: couponId })
      } catch { /* best-effort */ }
      throw err
    }
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})