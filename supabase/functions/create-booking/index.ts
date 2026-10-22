import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { paymentNonRequotableReason } from "../_shared/payments.ts"
import { isDeletionPending, deletionPendingResponse } from "../_shared/deletion.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
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

    if (await isDeletionPending(supabase, user.id)) return deletionPendingResponse()

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
      // Never resurrect a cancelled registration that holds a paid or
      // refunding payment — the money already moved; re-booking would hand
      // the user a Pay screen (or an "already paid" no-op) for that payment.
      if (existing.status === "cancelled") {
        const { data: existingPayment } = await supabase
          .from("payments")
          .select("status, refund_status, refund_claim_state")
          .eq("registration_id", existing.id)
          .maybeSingle()
        const blockReason = existingPayment ? paymentNonRequotableReason(existingPayment) : null
        if (blockReason === "already_paid") {
          return new Response(JSON.stringify({ error: "You have already paid for this event.", code: "already_paid" }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
        if (blockReason) {
          return new Response(JSON.stringify({ error: "A refund for this payment is in progress.", code: blockReason }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
        }
      }
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

    if (regErr) {
      // Concurrent duplicate: another request created the registration between
      // our SELECT and INSERT. Return the winner instead of a 500.
      if (regErr.code === "23505") {
        const { data: raced } = await supabase
          .from("registrations")
          .select("id")
          .eq("event_id", event_id)
          .eq("user_id", user.id)
          .maybeSingle()
        if (raced) return new Response(JSON.stringify({ registration_id: raced.id, is_paid: event.price > 0 }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
      }
      throw regErr
    }

    return new Response(JSON.stringify({ registration_id: reg!.id, is_paid: event.price > 0 }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
