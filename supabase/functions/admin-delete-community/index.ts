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
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized." }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session." }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single()
    if (!profile?.is_admin) {
      return new Response(JSON.stringify({ error: "Access denied." }), {
        status: 403, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { community_id } = await req.json()
    if (!community_id) {
      return new Response(JSON.stringify({ error: "community_id is required." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: community } = await supabase
      .from("communities")
      .select("name, owner_id")
      .eq("id", community_id)
      .single()

    const now = new Date().toISOString()
    await supabase.from("communities").update({ deleted_at: now }).eq("id", community_id)
    await supabase.from("events").update({ deleted_at: now }).eq("community_id", community_id)

    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: "community_deleted",
      target_type: "community",
      target_id: community_id,
      details: { community_name: community?.name, community_owner_id: community?.owner_id },
    })

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch {
    return new Response(JSON.stringify({ error: "Something went wrong." }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
