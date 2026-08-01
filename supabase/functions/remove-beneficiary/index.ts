import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"

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
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const rl = await checkRateLimit(user.id, "remove-beneficiary")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { community_id, beneficiary_id } = await req.json()
    if (!community_id || !beneficiary_id) {
      return new Response(JSON.stringify({ error: "community_id and beneficiary_id are required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: community } = await supabase
      .from("communities")
      .select("owner_id")
      .eq("id", community_id)
      .single()

    if (!community) return new Response(JSON.stringify({ error: "Community not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (community.owner_id !== user.id) return new Response(JSON.stringify({ error: "Only the community owner can manage beneficiaries" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: beneficiary, error: benErr } = await supabase
      .from("community_beneficiaries")
      .select("id, is_active")
      .eq("id", beneficiary_id)
      .eq("community_id", community_id)
      .single()

    if (!beneficiary || benErr) return new Response(JSON.stringify({ error: "Beneficiary not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (beneficiary.is_active) return new Response(JSON.stringify({ error: "Cannot remove active beneficiary. Switch to another account first." }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { count } = await supabase
      .from("community_beneficiaries")
      .select("id", { count: "exact", head: true })
      .eq("community_id", community_id)

    if (count && count <= 1) return new Response(JSON.stringify({ error: "Cannot remove the only beneficiary" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    await supabase
      .from("community_beneficiaries")
      .delete()
      .eq("id", beneficiary_id)

    await supabase.from("payment_audit_log").insert({
      action: "beneficiary_removed",
      details: { community_id, beneficiary_id },
    })

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    const msg = err instanceof Error ? err.message : "Something went wrong"
    return new Response(JSON.stringify({ error: msg }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
