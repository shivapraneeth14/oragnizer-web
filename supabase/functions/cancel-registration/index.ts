import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

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
        // Step 1: Refund the payment
        const refund = await razorpayPost(`payments/${payment.razorpay_payment_id}/refund`, { amount: payment.amount })

        // Step 2: Check for processed transfer and reverse it
        const { data: transfer } = await supabase
          .from("payment_transfers")
          .select("id, status, razorpay_transfer_id")
          .eq("payment_id", payment.id)
          .maybeSingle()

        if (transfer?.status === "processed" && transfer?.razorpay_transfer_id) {
          try {
            await razorpayPost(`transfers/${transfer.razorpay_transfer_id}/reverse`, {})
            await supabase.from("payment_transfers").update({ status: "reversed", updated_at: new Date().toISOString() }).eq("id", transfer.id)
          } catch (reverseErr) {
            console.error("Reverse transfer failed:", reverseErr)
          }
        }

        // Step 3: Update payment status
        await supabase.from("payments").update({
          status: "refunded",
          refund_status: "processed",
        }).eq("id", payment.id)

        // Step 4: Audit log
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
        // Continue with cancellation even if refund fails (registration cancelled, refund will be handled manually)
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
