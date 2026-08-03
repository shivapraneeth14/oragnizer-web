import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
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
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  const ip = getClientIp(req)
  const rl = await checkRateLimit(ip, "check-community-email")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  try {
    const { email, community_id } = await req.json()

    if (!email || typeof email !== "string" || email.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Please enter an email." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    let query = supabase
      .from("communities")
      .select("id")
      .eq("contact_email", email.trim())
      .is("deleted_at", null)

    if (community_id) {
      query = query.neq("id", community_id)
    }

    const { data, error } = await query.maybeSingle()

    if (error) throw error

    return new Response(JSON.stringify({ available: !data }), {
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
