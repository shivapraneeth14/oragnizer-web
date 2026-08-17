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

async function createRazorpayOrder(amount: number, registrationId: string) {
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

    await supabase.from("payments").update({ razorpay_payment_id: captured.id }).eq("id", paymentId)
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

    const { data: existing } = await supabase
      .from("registrations")
      .select("id, status")
      .eq("event_id", event_id)
      .eq("user_id", user.id)
      .maybeSingle()

    let registrationId: string
    if (existing) {
      if (existing.status === "confirmed") return new Response(JSON.stringify({ error: "Already registered" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
      if (existing.status === "cancelled") {
        await supabase
          .from("registrations")
          .update({ status: "pending", deleted_at: null, updated_at: new Date().toISOString() })
          .eq("id", existing.id)
      }
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

    const amount = event.price
    let finalAmount = amount
    let couponId: string | null = null

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

      const { data: claimResult } = await supabase
        .rpc("claim_coupon", { p_coupon_id: coupon.id })

      if (claimResult?.claimed) {
        let discount = 0
        if (coupon.discount_type === "percentage") {
          discount = Math.floor(amount * coupon.discount_value / 100)
        } else {
          discount = coupon.discount_value
        }

        finalAmount = Math.max(amount - discount, 0)
        couponId = coupon.id
      }
    }

    const { data: existingPayment } = await supabase
      .from("payments")
      .select("id, razorpay_order_id, status, created_at, attempt_count")
      .eq("registration_id", registrationId)
      .maybeSingle()

    if (existingPayment) {
      if (existingPayment.status === "success") return new Response(JSON.stringify({ error: "Already paid" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })

      if (existingPayment.status === "pending" && existingPayment.razorpay_order_id) {
        const orderAge = Date.now() - new Date(existingPayment.created_at).getTime()
        if (orderAge < 24 * 60 * 60 * 1000) {
          // Path C: if the money already landed, confirm instead of reusing
          // the order (the success callback may have been lost).
          const confirmed = await confirmPaidOrder(existingPayment.id, existingPayment.razorpay_order_id)
          if (confirmed?.confirmed) {
            return new Response(JSON.stringify({ exists: true, payment_status: "confirmed", registration_id: registrationId }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
          }
          if (confirmed !== null) {
            return new Response(JSON.stringify({ error: "Your payment was received but could not be confirmed. Payment will be refunded." }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
          }
          return new Response(JSON.stringify({ registration_id: registrationId, razorpay_order_id: existingPayment.razorpay_order_id, amount: finalAmount }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
    }

    const attemptCount = (existingPayment?.attempt_count ?? 0) + 1
    const order = await createRazorpayOrder(finalAmount, `${registrationId}_${attemptCount}`)

    try {
      if (existingPayment) {
        await supabase
          .from("payments")
          .update({
            razorpay_order_id: order.id,
            status: "pending",
            amount: finalAmount,
            coupon_id: couponId,
            attempt_count: attemptCount,
            created_at: new Date().toISOString(),
          })
          .eq("id", existingPayment.id)
      } else {
        const { data: newPayment, error: insertError } = await supabase
          .from("payments")
          .insert({
            registration_id: registrationId,
            amount: finalAmount,
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
    } catch (insertErr: any) {
      if (insertErr?.code === "23505") {
        const { data: recovered } = await supabase
          .from("payments")
          .select("razorpay_order_id")
          .eq("registration_id", registrationId)
          .single()
        if (recovered) {
          return new Response(JSON.stringify({ registration_id: registrationId, razorpay_order_id: recovered.razorpay_order_id, amount: finalAmount }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
      throw insertErr
    }

    return new Response(JSON.stringify({ registration_id: registrationId, razorpay_order_id: order.id, amount: finalAmount }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
