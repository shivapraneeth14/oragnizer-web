import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { getCorsHeaders } from "../_shared/cors.ts"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
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

    const rl = await checkRateLimit(user.id, "remove-member")
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfter)
    }

    const { community_id, user_id } = await req.json()
    if (!community_id || !user_id) {
      return new Response(JSON.stringify({ error: "community_id and user_id are required" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (user.id === user_id) {
      return new Response(JSON.stringify({ error: "Use leave community to self-remove" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // 1. Determine caller authorization: platform admin, community owner, or organizer
    const { data: callerProfile } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single()
    const callerIsAdmin = Boolean(callerProfile?.is_admin)

    const { data: callerMembership } = await supabase
      .from("community_members")
      .select("role")
      .eq("community_id", community_id)
      .eq("user_id", user.id)
      .maybeSingle()
    const callerRole = callerMembership?.role?.toUpperCase() || null

    const canModerate = callerIsAdmin || callerRole === "OWNER" || callerRole === "ORGANIZER"
    if (!canModerate) {
      return new Response(
        JSON.stringify({ error: "Only community owners, organizers, or administrators can remove members" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
      )
    }

    // 2. Fetch target member
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

    const targetRole = target.role?.toUpperCase()

    // 3. Hierarchy and protection rules
    if (targetRole === "OWNER") {
      return new Response(JSON.stringify({ error: "Cannot remove the community owner" }), {
        status: 403, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (!callerIsAdmin && callerRole !== "OWNER" && (targetRole === "ORGANIZER" || targetRole === "MODERATOR")) {
      return new Response(JSON.stringify({ error: "Organizers cannot remove other team members" }), {
        status: 403, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // 4. Fetch community name for notification
    const { data: community } = await supabase
      .from("communities")
      .select("name")
      .eq("id", community_id)
      .single()

    if (!community) {
      return new Response(JSON.stringify({ error: "Community not found" }), {
        status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // 5. Perform member removal
    await supabase
      .from("community_members")
      .delete()
      .eq("community_id", community_id)
      .eq("user_id", user_id)

    // 6. Asynchronous notification & audit logging
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
      details: {
        community_id,
        role: target.role,
        caller_role: callerIsAdmin ? "ADMIN" : callerRole,
      },
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
