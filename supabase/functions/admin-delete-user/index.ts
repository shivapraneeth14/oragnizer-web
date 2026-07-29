import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

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

    const rl = await checkRateLimit(user.id, "admin-delete-user")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { user_id } = await req.json()
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id is required." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (user_id === user.id) {
      return new Response(JSON.stringify({ error: "Cannot delete yourself." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: profileData } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user_id)
      .single()

    const now = new Date().toISOString()
    await supabase.from("profiles").update({ deleted_at: now }).eq("id", user_id)
    await supabase.auth.admin.signOut(user_id)

    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: "user_deleted",
      target_type: "user",
      target_id: user_id,
      details: { profile_data: profileData },
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
