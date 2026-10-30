import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { platformFeeForTicket } from "../_shared/fees.ts"
import { clearRefundFieldsForRequote, paymentNonRequotableReason } from "../_shared/payments.ts"
import { hasConsentRecord } from "../_shared/consent.ts"
import { isDeletionPending, deletionPendingResponse } from "../_shared/deletion.ts"
import { razorpayPost } from "../_shared/razorpay.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
}

async function createRazorpayOrder(amount: number, registrationId: string) {
  const idempotencyKey = `order_${registrationId}`
  const body = { amount, currency: "INR", receipt: registrationId }
  const result = await razorpayPost("orders", body, { idempotencyKey })
  if (!result || !result.id) {
    throw new Error("Razorpay returned an invalid order response")
  }
  return result
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

    const rl = await checkRateLimit(user.id, "create-payment-order")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    // Server-side consent backstop: no payment order without a recorded
    // policy consent (see _shared/consent.ts). Any recorded version suffices.
    if (!(await hasConsentRecord(supabase, user.id))) {
      return new Response(JSON.stringify({ error: "Please accept the Privacy Policy and Terms of Service to continue." }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    if (await isDeletionPending(supabase, user.id)) return deletionPendingResponse()

    const { registration_id, coupon_code } = await req.json()
    if (!registration_id) return new Response(JSON.stringify({ error: "registration_id is required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: registration } = await supabase
      .from("registrations")
      .select("id, status, event_id, user_id")
      .eq("id", registration_id)
      .single()

    if (!registration) return new Response(JSON.stringify({ error: "Registration not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (registration.user_id !== user.id) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (registration.status === "confirmed") return new Response(JSON.stringify({ error: "Already confirmed" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (registration.status === "cancelled") return new Response(JSON.stringify({ error: "Registration expired" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: event } = await supabase
      .from("events")
      .select("id, price, title, community_id, status, start_date, deleted_at")
      .eq("id", registration.event_id)
      .single()

    if (!event || event.price <= 0) return new Response(JSON.stringify({ error: "Event is free or not found" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.deleted_at) return new Response(JSON.stringify({ error: "Event has been deleted" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.status !== "published") return new Response(JSON.stringify({ error: "Event is not available" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.start_date && new Date(event.start_date) < new Date()) return new Response(JSON.stringify({ error: "Event has already started" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: community } = await supabase
      .from("communities")
      .select("id, commission_percent")
      .eq("id", event.community_id)
      .maybeSingle()

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
      // NOT claimed here: a use is reserved only when this call actually
      // creates a new order (see below).
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

    // Check for existing payment — reuse valid order, avoid duplicate
    const { data: existingPayment } = await supabase
      .from("payments")
      .select("id, razorpay_order_id, razorpay_payment_id, status, refund_status, refund_claim_state, refund_reason, refund_amount_due, refund_attempt_count, created_at, attempt_count, amount")
      .eq("registration_id", registration_id)
      .maybeSingle()

    if (existingPayment) {
      const blockReason = paymentNonRequotableReason(existingPayment)
      if (blockReason === "already_paid") return new Response(JSON.stringify({ error: "You have already paid for this event.", code: "already_paid" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
      if (blockReason) return new Response(JSON.stringify({ error: "A refund for your previous booking is being processed. You can rebook once it completes — we'll notify you.", code: blockReason }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })

      if (existingPayment.status === "pending" && existingPayment.razorpay_order_id) {
        const orderAge = Date.now() - new Date(existingPayment.created_at).getTime()
        // Reuse only if quoted at today's math; otherwise re-quote.
        if (orderAge < 24 * 60 * 60 * 1000 && Number(existingPayment.amount) === finalAmount) {
          // NO coupon claim on the reuse path: the existing payment row already
          // consumed its use (or has none); returning the order must not burn a
          // second one — a later reconcile release cannot undo the phantom.
          return new Response(JSON.stringify({ razorpay_order_id: existingPayment.razorpay_order_id, amount: finalAmount, platform_fee: fee.total, platform_fee_gst: fee.gst, ticket_price: ticket }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
    }

    // Atomically reserve a use ONLY when a new order will be created.
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
    // must never permanently burn a coupon use.
    try {
      const order = await createRazorpayOrder(finalAmount, `${registration_id}_${attemptCount}`)

      // Insert or update payments row with 23505 recovery for concurrent double-tap
      let paymentId: string
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
        paymentId = existingPayment.id
      } else {
        const { data: newPayment, error: insertError } = await supabase
          .from("payments")
          .insert({
            registration_id,
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
        paymentId = newPayment.id
      }

      return new Response(JSON.stringify({ razorpay_order_id: order.id, amount: finalAmount, platform_fee: fee.total, platform_fee_gst: fee.gst, ticket_price: ticket }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    } catch (err: any) {
      if (err?.code === "23505") {
        // Concurrent double-tap: another request won the payment row. Release
        // THIS call's claim — the winner's claim is the one tied to the row.
        if (couponId) {
          try { await supabase.rpc("release_coupon", { p_coupon_id: couponId }) } catch { /* best-effort */ }
        }
        const { data: recovered } = await supabase
          .from("payments")
          .select("razorpay_order_id")
          .eq("registration_id", registration_id)
          .single()
        if (recovered) {
          return new Response(JSON.stringify({ razorpay_order_id: recovered.razorpay_order_id, amount: finalAmount, platform_fee: fee.total, platform_fee_gst: fee.gst, ticket_price: ticket }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
      // Any other failure (provider, insert) → release the claim, then rethrow.
      if (couponId) {
        try { await supabase.rpc("release_coupon", { p_coupon_id: couponId }) } catch { /* best-effort */ }
      }
      throw err
    }
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
