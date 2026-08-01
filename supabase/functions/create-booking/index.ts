import { createClient } from "jsr:@supabase/supabase-js@2"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const MIN_WITHDRAWAL_PAISE = 10000
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
      .select("id, price, status, deleted_at, capacity, booked_count, title, community_id, start_date")
      .eq("id", event_id)
      .single()

    if (eventErr || !event) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.deleted_at) return new Response(JSON.stringify({ error: "Event has been deleted" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.status === "cancelled") return new Response(JSON.stringify({ error: "Event has been cancelled" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.status === "completed") return new Response(JSON.stringify({ error: "Event has ended" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.status !== "published") return new Response(JSON.stringify({ error: "Event is not available" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.start_date && new Date(event.start_date) < new Date()) return new Response(JSON.stringify({ error: "Event has already started" }), { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (event.capacity !== null && event.booked_count >= event.capacity) return new Response(JSON.stringify({ error: "Event is full" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: existing } = await supabase
      .from("registrations")
      .select("id, status")
      .eq("event_id", event_id)
      .eq("user_id", user.id)
      .maybeSingle()

    if (existing) {
      if (existing.status === "confirmed") return new Response(JSON.stringify({ error: "Already registered" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
      // pending or cancelled: reuse existing registration
      if (existing.status === "cancelled") {
        await supabase
          .from("registrations")
          .update({ status: "pending", deleted_at: null, updated_at: new Date().toISOString() })
          .eq("id", existing.id)
      }
      return new Response(JSON.stringify({ registration_id: existing.id, is_paid: event.price > 0 }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: reg, error: regErr } = await supabase
      .from("registrations")
      .insert({ event_id, user_id: user.id, status: "pending" })
      .select("id")
      .single()

    if (regErr) throw regErr

    return new Response(JSON.stringify({ registration_id: reg!.id, is_paid: event.price > 0 }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
