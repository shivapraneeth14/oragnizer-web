import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
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
      .select("id, status, coupon_id")
      .eq("registration_id", registration.id)
      .maybeSingle()

    if (payment && (payment.status === "pending" || payment.status === "created")) {
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
