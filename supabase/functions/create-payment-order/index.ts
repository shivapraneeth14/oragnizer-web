import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID")!
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET")!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
}

async function createRazorpayOrder(amount: number, registrationId: string, transfers: any[]) {
  const idempotencyKey = `order_${registrationId}`
  const body: any = { amount, currency: "INR", receipt: registrationId }
  if (transfers.length > 0) {
    body.transfers = transfers
  }

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

    const { registration_id } = await req.json()
    if (!registration_id) return new Response(JSON.stringify({ error: "registration_id is required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: registration } = await supabase
      .from("registrations")
      .select("id, status, event_id, user_id")
      .eq("id", registration_id)
      .single()

    if (!registration) return new Response(JSON.stringify({ error: "Registration not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (registration.status === "confirmed") return new Response(JSON.stringify({ error: "Already confirmed" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (registration.status === "cancelled") return new Response(JSON.stringify({ error: "Registration expired" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: event } = await supabase
      .from("events")
      .select("id, price, title, community_id")
      .eq("id", registration.event_id)
      .single()

    if (!event || event.price <= 0) return new Response(JSON.stringify({ error: "Event is free or not found" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: community } = await supabase
      .from("communities")
      .select("id, razorpay_account_id, razorpay_account_status, commission_percent")
      .eq("id", event.community_id)
      .single()

    // Build transfers array if organizer has a linked account
    const platformFee = Math.round(event.price * (community?.commission_percent ?? 10) / 100)
    const organizerShare = event.price - platformFee
    const amount = event.price

    const transfers: any[] = []
    if (community?.razorpay_account_id && organizerShare > 0) {
      transfers.push({
        account: community.razorpay_account_id,
        amount: organizerShare,
        currency: "INR",
        on_hold: community.razorpay_account_status !== "activated",
      })
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
          return new Response(JSON.stringify({ razorpay_order_id: existingPayment.razorpay_order_id, amount }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
    }

    // Create Razorpay order with idempotency key (includes transfers for Route splits)
    const attemptCount = (existingPayment?.attempt_count ?? 0) + 1
    const order = await createRazorpayOrder(amount, `${registration_id}_${attemptCount}`, transfers)

    // Insert or update payments row with 23505 recovery for concurrent double-tap
    let paymentId: string
    try {
      if (existingPayment) {
        await supabase
          .from("payments")
          .update({
            razorpay_order_id: order.id,
            status: "pending",
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
            amount,
            razorpay_order_id: order.id,
            status: "pending",
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
          return new Response(JSON.stringify({ razorpay_order_id: recovered.razorpay_order_id, amount }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
      throw insertErr
    }

    // If transfers were included in the order, log to payment_transfers
    if (transfers.length > 0) {
      await supabase.from("payment_transfers").insert({
        payment_id: paymentId,
        community_id: event.community_id,
        amount: organizerShare,
        commission_amount: platformFee,
        status: "pending",
      })
    }

    return new Response(JSON.stringify({ razorpay_order_id: order.id, amount }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
