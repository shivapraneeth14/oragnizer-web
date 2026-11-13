import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { sendChigzoEmail } from "../_shared/send-email.ts"
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

async function isAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle()
  return data?.is_admin === true
}

// Sends the customer a "we could not refund your original payment method —
// please reply with your UPI ID" email for a failed refund, and records that
// support asked (refund_workflows.status = 'upi_requested').
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

    const rl = await checkRateLimit(user.id, "request-refund-upi")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { payment_id } = await req.json().catch(() => ({}))
    if (!payment_id) {
      return new Response(JSON.stringify({ error: "Payment ID required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: payment, error: paymentErr } = await supabase
      .from("payments")
      .select("id, amount, refund_amount_due, refund_status, registration_id, registrations!inner(id, user_id, event_id, events!inner(title))")
      .eq("id", payment_id)
      .maybeSingle()

    if (paymentErr || !payment) {
      return new Response(JSON.stringify({ error: "Payment not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (payment.refund_status !== "failed") {
      return new Response(JSON.stringify({
        error: "Payment refund is not in a failed state",
        current_status: payment.refund_status,
      }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const reg = (payment as any).registrations
    const eventTitle = reg?.events?.title ?? "your booking"
    const userId = reg?.user_id
    if (!userId) {
      return new Response(JSON.stringify({ error: "Registration has no customer" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("email, first_name")
      .eq("id", userId)
      .maybeSingle()

    const email = profile?.email
    if (!email) {
      return new Response(JSON.stringify({ error: "Customer has no email address" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const owed = Number(payment.refund_amount_due ?? payment.amount ?? 0)
    const amountText = `₹${(owed / 100).toFixed(0)}`
    const greeting = profile?.first_name ? `Hi ${profile.first_name},` : "Hi,"

    await sendChigzoEmail(
      email,
      `Refund for "${eventTitle}" — please share your UPI ID`,
      [
        greeting,
        "",
        `We could not send your refund of ${amountText} for "${eventTitle}" back to your original payment method.`,
        "",
        "Please reply to this email with your UPI ID (for example: yourname@okhdfc) and we will transfer the refund to you.",
        "",
        "— Chigzo Support",
      ].join("\n"),
    )

    // Record the workflow transition (admin asked for a UPI ID).
    const { data: rpcData, error: rpcError } = await supabase.rpc("mark_refund_upi_requested", {
      p_payment_id: payment_id,
      p_admin_id: user.id,
    })
    if (rpcError || rpcData?.error) {
      logError("request-refund-upi", rpcError ?? rpcData?.error)
    }

    await supabase.from("notifications").insert({
      user_id: userId,
      type: "refund_needs_attention",
      title: "Refund needs your UPI ID",
      body: `We could not refund ${amountText} for "${eventTitle}" to your original payment method. Please contact support and share your UPI ID.`,
      payload: { event_id: reg?.event_id ?? null, payment_id },
    })

    return new Response(JSON.stringify({ ok: true, emailed: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    logError("request-refund-upi", err)
    return new Response(JSON.stringify({ error: "Could not send the refund details request" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
