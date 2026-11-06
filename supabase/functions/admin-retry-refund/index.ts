import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { attemptRefund, refundRetryPlan, RefundNotPossibleError } from "../_shared/refunds.ts"
import { logError } from "../_shared/logger.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
}

const RETRY_CAP = 5

async function isAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle()
  return data?.is_admin === true
}

// Admin recovery for a refund whose Razorpay attempt failed. The registration
// is already cancelled and the debt is persisted in payments.refund_amount_due;
// this function ONLY re-sends the refund to Razorpay (it never cancels again
// and never performs a manual/offline settlement).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
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

    if (!(await isAdmin(user.id))) {
      return new Response(JSON.stringify({ error: "Admin privileges required" }), {
        status: 403,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const rl = await checkRateLimit(user.id, "admin-retry-refund")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { payment_id } = await req.json()
    if (!payment_id) {
      return new Response(JSON.stringify({ error: "Payment ID required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: payment, error: paymentErr } = await supabase
      .from("payments")
      .select("id, status, refund_status, refund_claim_state, refund_claim_at, refund_amount_due, refund_reason, refund_attempt_count, razorpay_payment_id, amount, platform_fee, organizer_share, registration_id")
      .eq("id", payment_id)
      .maybeSingle()

    if (paymentErr || !payment) {
      return new Response(JSON.stringify({ error: "Payment not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (!payment.razorpay_payment_id) {
      return new Response(JSON.stringify({ error: "Payment has no Razorpay payment id" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (!["failed", "success", "refunded"].includes(payment.status ?? "")) {
      return new Response(JSON.stringify({ error: "Payment is not refundable in its current state" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Only a failed attempt may be retried here. Live/processing refunds must
    // be left to the webhook/reconcile path (never double-issue).
    const isFailed = payment.refund_status === "failed" || payment.refund_claim_state === "failed"
    if (!isFailed) {
      return new Response(JSON.stringify({
        error: "This payment has no failed refund attempt to retry",
        current_status: payment.refund_status,
      }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    if (payment.refund_claim_state === "claimed" && payment.refund_claim_at) {
      const claimedAt = new Date(payment.refund_claim_at).getTime()
      if (Date.now() - claimedAt < 15 * 60 * 1000) {
        return new Response(JSON.stringify({ error: "Another refund attempt is currently in flight" }), {
          status: 409,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
    }

    if (Number(payment.refund_attempt_count ?? 0) >= RETRY_CAP) {
      return new Response(JSON.stringify({
        error: "Razorpay retry limit reached",
        message: "This refund has already failed 5 times. It still remains owed and reserved; contact Razorpay support or handle the manual settlement path.",
        attempts: payment.refund_attempt_count,
      }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: registration } = await supabase
      .from("registrations")
      .select("id, event_id, user_id, status")
      .eq("id", payment.registration_id)
      .maybeSingle()

    if (registration?.status === "attended") {
      return new Response(JSON.stringify({ error: "Attended tickets are permanently non-refundable" }), {
        status: 409,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { amount, reason } = refundRetryPlan(payment)

    const outcome = await attemptRefund(supabase, payment, amount, reason)

    if (outcome.status === "conflict") {
      return new Response(JSON.stringify({ error: "Another refund attempt is currently in flight" }), {
        status: 409,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (outcome.status === "already_refunded") {
      return new Response(JSON.stringify({
        success: true,
        already_refunded: true,
        refund_id: outcome.refund_id,
        status: outcome.refund_status,
      }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    await supabase.from("payment_audit_log").insert({
      action: "refund_admin_retry",
      payment_id: payment.id,
      details: {
        admin_id: user.id,
        refund_id: outcome.refund_id,
        amount,
        status: outcome.refund_status,
        attempt: outcome.attempt,
        recovered: outcome.recovered === true,
      },
    })

    if (registration?.user_id) {
      await supabase.from("notifications").insert({
        user_id: registration.user_id,
        type: "refund_initiated",
        title: "Refund Retry Initiated",
        body: `We have retried your ₹${(amount / 100).toFixed(0)} refund with the payment provider. You will be notified once it completes.`,
        payload: {
          payment_id: payment.id,
          registration_id: registration.id,
          event_id: registration.event_id,
          amount,
          retry: true,
        },
      })
    }

    return new Response(JSON.stringify({
      success: true,
      refund_id: outcome.refund_id,
      status: outcome.refund_status,
      amount,
      attempt: outcome.attempt,
      recovered: outcome.recovered === true,
    }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    logError("admin-retry-refund", err)
    const message = err instanceof RefundNotPossibleError
      ? err.message
      : "Something went wrong. Please try again."
    return new Response(JSON.stringify({ error: message }), {
      status: err instanceof RefundNotPossibleError ? 409 : 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
