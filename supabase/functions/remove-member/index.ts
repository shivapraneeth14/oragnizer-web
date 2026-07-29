import { createClient } from "jsr:@supabase/supabase-js@2"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
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
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const token = authHeader.replace("Bearer ", "")
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { community_id, user_id } = await req.json()
    if (!community_id || !user_id) {
      return new Response(JSON.stringify({ error: "community_id and user_id are required" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: membership } = await supabase
      .from("community_members")
      .select("role")
      .eq("community_id", community_id)
      .eq("user_id", user.id)
      .maybeSingle()

    if (!membership || membership.role !== "OWNER") {
      return new Response(JSON.stringify({ error: "Only the community owner can remove members" }), {
        status: 403, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: target } = await supabase
      .from("community_members")
      .select("role")
      .eq("community_id", community_id)
      .eq("user_id", user_id)
      .maybeSingle()

    if (!target) {
      return new Response(JSON.stringify({ error: "User is not a member" }), {
        status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (target.role === "OWNER") {
      return new Response(JSON.stringify({ error: "Cannot remove the community owner" }), {
        status: 403, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    await supabase
      .from("community_members")
      .delete()
      .eq("community_id", community_id)
      .eq("user_id", user_id)

    const { data: community } = await supabase
      .from("communities")
      .select("name")
      .eq("id", community_id)
      .single()

    await supabase.from("notifications").insert({
      user_id,
      type: "removed_from_community",
      title: "Removed from community",
      body: `You have been removed from "${community?.name || 'the community'}".`,
    })

    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: "member_removed",
      target_type: "member",
      target_id: user_id,
      details: { community_id, role: target.role },
    })

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
