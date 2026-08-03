import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

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

async function razorpayPost(path: string, body: any) {
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.description || "Razorpay API error")
  return data
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const token = authHeader.slice(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const rl = await checkRateLimit(user.id, "cancel-registration")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { event_id } = await req.json()
    if (!event_id) return new Response(JSON.stringify({ error: "Event ID required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: registration, error: findError } = await supabase
      .from("registrations")
      .select("id, event_id")
      .eq("event_id", event_id)
      .eq("user_id", user.id)
      .eq("status", "confirmed")
      .is("deleted_at", null)
      .maybeSingle()

    if (findError || !registration) return new Response(JSON.stringify({ error: "No active registration found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })

    // Check for payment and process refund
    const { data: payment } = await supabase
      .from("payments")
      .select("id, status, razorpay_payment_id, amount")
      .eq("registration_id", registration.id)
      .maybeSingle()

    if (payment && payment.status === "success" && payment.razorpay_payment_id) {
      try {
        const refund = await razorpayPost(`payments/${payment.razorpay_payment_id}/refund`, { amount: payment.amount })

        const { data: regEvent } = await supabase
          .from("registrations")
          .select("event_id")
          .eq("id", registration.id)
          .single()

        if (regEvent) {
          const { data: ev } = await supabase
            .from("events")
            .select("community_id")
            .eq("id", regEvent.event_id)
            .single()

          if (ev) {
            const { data: comm } = await supabase
              .from("communities")
              .select("id, commission_percent")
              .eq("id", ev.community_id)
              .single()

            if (comm) {
              const platformFee = Math.floor(Number(payment.amount) * Number(comm.commission_percent) / 100)
              const organizerShare = Number(payment.amount) - platformFee
              const { data: debitResult, error: debitError } = await supabase.rpc("debit_wallet", {
                p_community_id: comm.id,
                p_amount: organizerShare,
                p_reason: "registration_cancellation_refund",
              })
              if (debitError || debitResult?.error) {
                throw new Error(debitResult?.error || debitError?.message || "Wallet debit failed")
              }
            }
          }
        }

        await supabase.from("payments").update({
          status: "refunded",
          refund_status: "processed",
          razorpay_refund_id: refund.id,
          refunded_amount: payment.amount,
        }).eq("id", payment.id)

        await supabase.from("payment_audit_log").insert({
          action: "refund_issued",
          payment_id: payment.id,
          details: { refund_id: refund.id, amount: payment.amount, registration_id: registration.id },
        })
      } catch (refundErr) {
        console.error("Refund failed:", refundErr)
        await supabase.from("payments").update({ refund_status: "requested" }).eq("id", payment.id)
        await supabase.from("payment_audit_log").insert({
          action: "refund_failed",
          payment_id: payment.id,
          details: { error: String(refundErr) },
        })
      }
    }

    // Cancel registration
    await supabase.from("registrations").update({
      status: "cancelled",
      deleted_at: new Date().toISOString(),
    }).eq("id", registration.id)

    // Decrement booked_count
    await supabase.rpc("decrement_event_booked", { p_event_id: event_id })

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
