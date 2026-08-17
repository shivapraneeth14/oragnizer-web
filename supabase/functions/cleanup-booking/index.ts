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

// "Path C": before treating a pending booking as abandoned, ask RAZORPAY
// (the source of truth) whether the money actually landed. A payment that was
// captured but never confirmed must be CONFIRMED, never cancelled.
async function checkOrderStatus(orderId: string): Promise<"paid" | "open" | "failed" | "unknown"> {
  try {
    const res = await fetch(`https://api.razorpay.com/v1/orders/${orderId}`, {
      headers: {
        Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
      },
      signal: AbortSignal.timeout(15000),
    })
    const order = await res.json()
    if (!res.ok) return "unknown"
    if (order.status === "paid" && (order.amount_paid || 0) > 0) return "paid"
    if (order.status === "attempted") return "open"
    return order.status === "created" ? "open" : "failed"
  } catch (_) {
    return "unknown"
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const rl = await checkRateLimit(user.id, "cleanup-booking")
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
      return new Response(JSON.stringify({ success: true, cleaned: false }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    if (registration.status === "confirmed") {
      return new Response(JSON.stringify({ success: true, cleaned: false, reason: "confirmed" }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: payment } = await supabase
      .from("payments")
      .select("id, status, coupon_id, razorpay_order_id")
      .eq("registration_id", registration.id)
      .maybeSingle()

    if (payment && (payment.status === "pending" || payment.status === "created")) {
      // Path C: the customer may have paid even though the app lost the
      // success callback. Razorpay is the source of truth - if the order is
      // paid with a captured payment, CONFIRM instead of cancelling.
      if (payment.razorpay_order_id) {
        const orderState = await checkOrderStatus(payment.razorpay_order_id)
        if (orderState === "paid") {
          const payRes = await fetch(
            `https://api.razorpay.com/v1/orders/${payment.razorpay_order_id}/payments`,
            {
              headers: {
                Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
              },
              signal: AbortSignal.timeout(15000),
            },
          )
          const payBody = await payRes.json()
          const captured = payBody?.items?.find((p: any) => p.status === "captured")
          if (captured) {
            await supabase.from("payments").update({
              razorpay_payment_id: captured.id,
            }).eq("id", payment.id)

            const { data: confirmResult, error: confirmErr } = await supabase
              .rpc("confirm_payment", { p_payment_id: payment.id })

            if (!confirmErr && confirmResult?.action === "confirmed") {
              await supabase.from("payment_audit_log").insert({
                action: "booking_reconciled",
                details: {
                  event_id,
                  registration_id: registration.id,
                  payment_id: payment.id,
                  note: "Order was already paid - confirmed instead of cancelled (Path C)",
                },
              })
              return new Response(JSON.stringify({ success: true, cleaned: false, reconciled: true }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
            }
            if (!confirmErr && confirmResult?.action === "refund_required") {
              // Capacity full or event cancelled - never cancel a PAID
              // booking silently; the webhook auto-refund path covers it.
              return new Response(JSON.stringify({ success: true, cleaned: false, reconciled: "refund_required" }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
            }
          }
        }
      }

      const { error: payErr } = await supabase
        .from("payments")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("id", payment.id)
      if (payErr) {
        console.error("Failed to mark payment failed:", payErr)
        return new Response(JSON.stringify({ error: "Failed to clean up booking. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
      }

      if (payment.coupon_id) {
        await supabase.rpc("release_coupon", { p_coupon_id: payment.coupon_id })
      }
    }

    const { error: regErr } = await supabase
      .from("registrations")
      .update({ status: "cancelled", deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", registration.id)
    if (regErr) {
      console.error("Failed to cancel registration:", regErr)
      return new Response(JSON.stringify({ error: "Failed to clean up booking. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    await supabase.from("payment_audit_log").insert({
      action: "booking_cleaned_up",
      details: {
        event_id,
        registration_id: registration.id,
        payment_id: payment?.id,
      },
    })

    return new Response(JSON.stringify({ success: true, cleaned: true }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
