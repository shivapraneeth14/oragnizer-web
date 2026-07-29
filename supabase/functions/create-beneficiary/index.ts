import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { cashfreePost } from "../_shared/cashfree.ts"

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

    const rl = await checkRateLimit(user.id, "create-beneficiary")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { community_id, bank_account_number, bank_ifsc, bank_account_holder } = await req.json()
    if (!community_id || !bank_account_number || !bank_ifsc || !bank_account_holder) {
      return new Response(JSON.stringify({ error: "community_id, bank_account_number, bank_ifsc, bank_account_holder are required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: community } = await supabase
      .from("communities")
      .select("owner_id, cashfree_beneficiary_id")
      .eq("id", community_id)
      .single()

    if (!community) return new Response(JSON.stringify({ error: "Community not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (community.owner_id !== user.id) return new Response(JSON.stringify({ error: "Only the community owner can set up payouts" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const beneficiaryId = `bene_${community_id.replace(/-/g, "")}_${Date.now()}`
    const result = await cashfreePost("/addBeneficiary", {
      beneId: beneficiaryId,
      name: bank_account_holder,
      email: user.email || "organizer@cluvo.com",
      phone: "9999999999",
      bankAccount: bank_account_number,
      ifsc: bank_ifsc,
      address: "N/A",
      city: "N/A",
      state: "N/A",
      pincode: "000000",
    })

    await supabase
      .from("communities")
      .update({ cashfree_beneficiary_id: beneficiaryId })
      .eq("id", community_id)

    await supabase.from("payment_audit_log").insert({
      action: "beneficiary_created",
      details: {
        community_id,
        cashfree_beneficiary_id: beneficiaryId,
        cashfree_response: result,
      },
    })

    return new Response(JSON.stringify({ beneficiary_id: beneficiaryId }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    const msg = err instanceof Error ? err.message : "Something went wrong"
    return new Response(JSON.stringify({ error: msg }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
