import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

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
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  const ip = getClientIp(req)
  const rl = await checkRateLimit(ip, "check-community-name")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  try {
    const { name } = await req.json()

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Please enter a community name." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data, error } = await supabase
      .from("communities")
      .select("id")
      .eq("name", name.trim())
      .is("deleted_at", null)
      .maybeSingle()

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
