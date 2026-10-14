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

// Adopt a captured Razorpay order into a confirmed booking. Guarded by
// confirm_payment (terminal-state + event/capacity checks). Never issues a
// refund here — money-out stays server-side (reconcile) on purpose.
async function confirmCapturedOrder(paymentId: string, orderId: string): Promise<string> {
  const order = await razorpayGet(`orders/${orderId}`)
  if (order.status !== "paid" || (order.amount_paid || 0) <= 0) return "awaiting"

  const payBody = await razorpayGet(`orders/${orderId}/payments`)
  const captured = payBody?.items?.find((p: any) => p.status === "captured")
  if (!captured) return "awaiting"

  await supabase.from("payments").update({ razorpay_payment_id: captured.id }).eq("id", paymentId)
  const { data: confirmResult, error: confirmErr } = await supabase
    .rpc("confirm_payment", { p_payment_id: paymentId })
  if (confirmErr) throw confirmErr
  if (confirmResult?.error) return "needs_repair"
  if (confirmResult?.action === "refund_required") return "refund_pending"
  return "confirmed"
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

    const rl = await checkRateLimit(user.id, "verify-payment")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { event_id } = await req.json()
    if (!event_id) return new Response(JSON.stringify({ error: "event_id is required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: registration } = await supabase
      .from("registrations")
      .select("id, status")
      .eq("event_id", event_id)
      .eq("user_id", user.id)
      .maybeSingle()

    if (!registration) {
      return new Response(JSON.stringify({ state: "none" }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: payment } = await supabase
      .from("payments")
      .select("id, status, refund_status, razorpay_order_id, razorpay_payment_id, created_at")
      .eq("registration_id", registration.id)
      .is("deleted_at", null)
      .maybeSingle()

    if (!payment) {
      return new Response(JSON.stringify({ state: registration.status, registration_id: registration.id }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const paidStates = registration.status === "confirmed" || registration.status === "attended"
      ? "confirmed"
      : (payment.status === "success" ? "paid_needs_repair" : "awaiting")

    // Money captured + booking already confirmed → done.
    if (payment.status === "success" && paidStates === "confirmed") {
      return new Response(JSON.stringify({ state: "confirmed", registration_id: registration.id, payment_status: "success" }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    // Money captured but the booking was lost (reg pending/cancelled). We never
    // auto-heal from the client path — wallet/ledger semantics need the
    // dedicated repair RPC. Report clearly so the UI stops offering Pay.
    if (payment.status === "success") {
      return new Response(JSON.stringify({ state: "paid_needs_repair", registration_id: registration.id, payment_status: "success" }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    // Refund in flight / already refunded → terminal.
    if (payment.status === "refunded") {
      return new Response(JSON.stringify({ state: "refunded", registration_id: registration.id, payment_status: "refunded" }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    // In-flight order: ask Razorpay whether the money actually landed (this is
    // the client-side cache for the webhook that may not have delivered).
    if (payment.status === "pending" && payment.razorpay_order_id) {
      const orderAge = Date.now() - new Date(payment.created_at).getTime()
      if (orderAge < 24 * 60 * 60 * 1000) {
        try {
          const state = await confirmCapturedOrder(payment.id, payment.razorpay_order_id)
          return new Response(JSON.stringify({ state, registration_id: registration.id, payment_status: state === "confirmed" ? "success" : payment.status }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
        } catch (err) {
          console.error(`verify-payment Razorpay check failed for ${payment.id}:`, err)
          return new Response(JSON.stringify({ state: "awaiting", registration_id: registration.id, payment_status: payment.status }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
    }

    return new Response(JSON.stringify({ state: "awaiting", registration_id: registration.id, payment_status: payment.status }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})