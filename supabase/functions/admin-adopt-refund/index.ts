import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { razorpayGet, RazorpayClientError } from "../_shared/razorpay.ts"
import { logError } from "../_shared/logger.ts"
import { refundAmountForPayment } from "../_shared/refunds.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
}

interface ProviderRefundEntity {
  id: string
  entity?: string
  amount: number
  currency: string
  payment_id: string
  status: string
  receipt?: string | null
  speed_processed?: string
  created_at?: number
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Verify admin privileges
    const { data: profile } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .maybeSingle()
    if (!profile?.is_admin) {
      return new Response(JSON.stringify({ error: "Forbidden: Admin privileges required" }), {
        status: 403,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const rl = await checkRateLimit(user.id, "admin-adopt-refund")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const body = await req.json().catch(() => ({}))
    const { task_id, razorpay_refund_id, notes } = body
    if (!task_id) {
      return new Response(JSON.stringify({ error: "Task ID required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const cleanRefundId = (razorpay_refund_id ?? "").trim()
    if (!cleanRefundId || cleanRefundId.length < 10 || !/^rfnd_[A-Za-z0-9]+$/.test(cleanRefundId)) {
      return new Response(
        JSON.stringify({ error: "Invalid Razorpay Refund ID format (must match rfnd_[A-Za-z0-9]+ and be >= 10 characters)" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
      )
    }

    // 1. Fetch Task Details
    const { data: task, error: taskErr } = await supabase
      .from("refund_task_queue")
      .select("id, status, amount, payment_id, registration_id, event_id")
      .eq("id", task_id)
      .maybeSingle()

    if (taskErr || !task) {
      return new Response(JSON.stringify({ error: "Refund task not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (task.status === "completed") {
      return new Response(JSON.stringify({ error: "Refund task is already completed" }), {
        status: 409,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (!task.payment_id) {
      return new Response(JSON.stringify({ error: "Task has no associated payment" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // 2. Fetch Linked Payment
    const { data: payment, error: payErr } = await supabase
      .from("payments")
      .select("id, razorpay_payment_id, amount, currency, status, registration_id, platform_fee, organizer_share")
      .eq("id", task.payment_id)
      .maybeSingle()

    if (payErr || !payment || !payment.razorpay_payment_id) {
      return new Response(JSON.stringify({ error: "Associated captured payment not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // The queue row may predate the fee-kept policy. Derive the refundable
    // amount from the payment breakdown instead of trusting task.amount:
    // ticket only when a ticket was issued, full amount when it never was.
    const expectedRefundAmount = refundAmountForPayment(payment)

    // 3. Attended Registration Guard
    const { data: reg } = await supabase
      .from("registrations")
      .select("status")
      .eq("id", task.registration_id)
      .maybeSingle()

    if (reg?.status === "attended") {
      return new Response(
        JSON.stringify({ error: "Cannot adopt refund: Attendee has already attended the event." }),
        { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } },
      )
    }

    // 4. Server-Side Verification against Razorpay API
    let providerRefund: ProviderRefundEntity
    try {
      providerRefund = await razorpayGet(`refunds/${cleanRefundId}`)
    } catch (err) {
      if (err instanceof RazorpayClientError && err.status === 404) {
        return new Response(
          JSON.stringify({ error: `Refund ID ${cleanRefundId} was not found at Razorpay.` }),
          { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } },
        )
      }
      console.error("[admin-adopt-refund] Razorpay API lookup failed:", err)
      return new Response(
        JSON.stringify({ error: "Failed to verify refund with Razorpay. Please check network and credentials." }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } },
      )
    }

    // Verify refund matches expected payment
    if (providerRefund.payment_id !== payment.razorpay_payment_id) {
      return new Response(
        JSON.stringify({
          error: `Provider refund belongs to Razorpay payment ${providerRefund.payment_id}, but task expected ${payment.razorpay_payment_id}.`,
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
      )
    }

    // Verify refund amount matches the policy amount (paise precision)
    if (Number(providerRefund.amount) !== Number(expectedRefundAmount)) {
      return new Response(
        JSON.stringify({
          error: `Provider refund amount mismatch: Razorpay has ₹${(providerRefund.amount / 100).toFixed(2)} (${providerRefund.amount} paise), expected ₹${(expectedRefundAmount / 100).toFixed(2)} (${expectedRefundAmount} paise).`,
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
      )
    }

    // Verify currency
    if (providerRefund.currency && providerRefund.currency.toUpperCase() !== "INR") {
      return new Response(
        JSON.stringify({
          error: `Provider refund currency mismatch: expected INR, got ${providerRefund.currency}.`,
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
      )
    }

    // Verify provider status: ONLY accept 'processed' for completed settlement
    const providerStatus = (providerRefund.status ?? "").toLowerCase()
    if (["failed", "reversed", "cancelled"].includes(providerStatus)) {
      return new Response(
        JSON.stringify({
          error: `Provider refund is in '${providerStatus}' state at Razorpay. It did not move money and cannot be adopted as completed.`,
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
      )
    }

    if (["pending", "queued", "created"].includes(providerStatus)) {
      return new Response(
        JSON.stringify({
          error: `Provider refund is currently in '${providerStatus}' state at Razorpay. Funds have not settled. Please wait for provider processing before adopting.`,
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
      )
    }

    if (providerStatus !== "processed") {
      return new Response(
        JSON.stringify({
          error: `Provider refund status '${providerStatus}' is not eligible for completed adoption.`,
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
      )
    }

    // 5. Invoke Database Adoption RPC
    const { data: adoptRes, error: adoptErr } = await supabase.rpc("admin_adopt_provider_refund", {
      p_task_id: task.id,
      p_admin_id: user.id,
      p_razorpay_refund_id: cleanRefundId,
      p_notes: notes ? String(notes).trim() : null,
    })

    if (adoptErr) {
      console.error("[admin-adopt-refund] Database adoption RPC error:", adoptErr)
      return new Response(
        JSON.stringify({ error: "Database error during refund adoption." }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      )
    }

    if (adoptRes?.error) {
      const status = adoptRes.error === "not_refundable_attended" ? 409 : 400
      return new Response(
        JSON.stringify({ error: adoptRes.message || adoptRes.error }),
        { status, headers: { "Content-Type": "application/json", ...corsHeaders } },
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        task_id: task.id,
        refund_id: cleanRefundId,
        status: "processed",
        amount: task.amount,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    )
  } catch (err) {
    logError("admin-adopt-refund", err)
    return new Response(
      JSON.stringify({ error: "Something went wrong. Please try again." }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    )
  }
})

