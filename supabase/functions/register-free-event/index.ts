import { createClient } from "jsr:@supabase/supabase-js@2"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
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

    const { event_id } = await req.json()
    if (!event_id) return new Response(JSON.stringify({ error: "event_id is required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: event, error: eventErr } = await supabase
      .from("events")
      .select("id, capacity, booked_count, status, deleted_at, price")
      .eq("id", event_id)
      .single()

    if (eventErr || !event) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.deleted_at) return new Response(JSON.stringify({ error: "Event has been deleted" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.price > 0) return new Response(JSON.stringify({ error: "Use create-booking + create-payment-order for paid events" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: existing } = await supabase
      .from("registrations")
      .select("id, status")
      .eq("event_id", event_id)
      .eq("user_id", user.id)
      .maybeSingle()

    if (existing) {
      if (existing.status === "confirmed") return new Response(JSON.stringify({ error: "Already registered" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })

      if (existing.status === "cancelled") {
        await supabase.from("registrations").update({ status: "confirmed", deleted_at: null }).eq("id", existing.id)
        // Atomic capacity check + booked_count increment
        const { data: bookResult, error: bookError } = await supabase.rpc('increment_event_booked', { p_event_id: event_id })
        if (bookError || bookResult?.error) {
          await supabase.from("registrations").update({ status: "cancelled", deleted_at: new Date().toISOString() }).eq("id", existing.id)
          return new Response(JSON.stringify({ error: "Event is full" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
        return new Response(JSON.stringify({ success: true, registration_id: existing.id }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
      }
    }

    const { data: reg, error: regErr } = await supabase
      .from("registrations")
      .insert({ event_id, user_id: user.id, status: "confirmed" })
      .select("id")
      .single()

    if (regErr) throw regErr

    // Atomic capacity check + booked_count increment
    const { data: bookResult, error: bookError } = await supabase.rpc('increment_event_booked', { p_event_id: event_id })
    if (bookError || bookResult?.error) {
      await supabase.from("registrations").update({ status: "cancelled", deleted_at: new Date().toISOString() }).eq("id", reg!.id)
      return new Response(JSON.stringify({ error: "Event is full" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    return new Response(JSON.stringify({ success: true, registration_id: reg!.id }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
