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
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
      .select("id, price, title, community_id, status")
      .eq("id", registration.event_id)
      .single()

    if (!event || event.price <= 0) return new Response(JSON.stringify({ error: "Event is free or not found" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.status !== "published") return new Response(JSON.stringify({ error: "Event is not available" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })

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

    // Check for existing payment — reuse valid order, avoid duplicate
    const { data: existingPayment } = await supabase
      .from("payments")
      .select("id, razorpay_order_id, status, created_at, attempt_count")
      .eq("registration_id", registration_id)
      .maybeSingle()

    if (existingPayment) {
      if (existingPayment.status === "success") return new Response(JSON.stringify({ error: "Already paid" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })

      if (existingPayment.status === "pending" && existingPayment.razorpay_order_id) {
        const orderAge = Date.now() - new Date(existingPayment.created_at).getTime()
        if (orderAge < 24 * 60 * 60 * 1000) {
          return new Response(JSON.stringify({ razorpay_order_id: existingPayment.razorpay_order_id, amount: finalAmount }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
    }

    const attemptCount = (existingPayment?.attempt_count ?? 0) + 1
    const order = await createRazorpayOrder(finalAmount, `${registration_id}_${attemptCount}`)

    // Insert or update payments row with 23505 recovery for concurrent double-tap
    let paymentId: string
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
        paymentId = existingPayment.id
      } else {
        const { data: newPayment, error: insertError } = await supabase
          .from("payments")
          .insert({
            registration_id,
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
        paymentId = newPayment.id
      }
    } catch (insertErr: any) {
      if (insertErr?.code === "23505") {
        const { data: recovered } = await supabase
          .from("payments")
          .select("razorpay_order_id")
          .eq("registration_id", registration_id)
          .single()
        if (recovered) {
          return new Response(JSON.stringify({ razorpay_order_id: recovered.razorpay_order_id, amount: finalAmount }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
      throw insertErr
    }

    return new Response(JSON.stringify({ razorpay_order_id: order.id, amount: finalAmount }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
