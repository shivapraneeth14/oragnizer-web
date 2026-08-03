import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
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
      return new Response(JSON.stringify({ error: "Unauthorized. Please sign in again." }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session. Please sign in again." }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { event_id } = await req.json()

    if (!event_id) {
      return new Response(JSON.stringify({ error: "Event ID is required." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, capacity, booked_count, status, deleted_at, price, start_date")
      .eq("id", event_id)
      .single()

    if (eventError || !event) {
      return new Response(JSON.stringify({ error: "Event not found." }), {
        status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (event.deleted_at) {
      return new Response(JSON.stringify({ error: "This event has been deleted." }), {
        status: 410, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (event.status === "cancelled") {
      return new Response(JSON.stringify({ error: "This event has been cancelled." }), {
        status: 410, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (event.status === "completed") {
      return new Response(JSON.stringify({ error: "This event has ended." }), {
        status: 410, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (event.status !== "published") {
      return new Response(JSON.stringify({ error: "This event is not available." }), {
        status: 410, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (event.start_date && new Date(event.start_date) < new Date()) {
      return new Response(JSON.stringify({ error: "This event has already started." }), {
        status: 410, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (event.price > 0) {
      return new Response(JSON.stringify({ error: "Please proceed to payment." }), {
        status: 402, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: existing } = await supabase
      .from("registrations")
      .select("id, status")
      .eq("event_id", event_id)
      .eq("user_id", user.id)
      .maybeSingle()

    if (existing && existing.status === "confirmed") {
      return new Response(JSON.stringify({ error: "You are already registered for this event." }), {
        status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    let registrationId: string

    if (existing && existing.status === "cancelled") {
      const { data: updated, error: updateError } = await supabase
        .from("registrations")
        .update({ status: "confirmed", deleted_at: null, registered_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select("id")
        .single()

      if (updateError) {
        console.error("Registration update failed:", updateError)
        return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
      registrationId = updated.id
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from("registrations")
        .insert({
          event_id,
          user_id: user.id,
          status: "confirmed",
        })
        .select("id")
        .single()

      if (insertError) {
        console.error("Registration insert failed:", insertError)
        if (insertError.message?.includes("duplicate key")) {
          return new Response(JSON.stringify({ error: "You are already registered for this event." }), {
            status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        }
        return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
      registrationId = inserted.id
    }

    // Atomic capacity check + booked_count increment
    const { data: bookResult, error: bookError } = await supabase
      .rpc('increment_event_booked', { p_event_id: event_id })

    if (bookError || bookResult?.error) {
      // Capacity full — rollback registration
      await supabase.from("registrations").update({
        status: "cancelled",
        deleted_at: new Date().toISOString(),
      }).eq("id", registrationId)

      return new Response(JSON.stringify({ error: bookResult?.error || "Event is full." }), {
        status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    return new Response(JSON.stringify({ success: true, registration_id: registrationId }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
