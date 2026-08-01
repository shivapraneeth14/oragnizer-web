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

    const { community_id, bank_account_number, bank_ifsc, bank_account_holder, label } = await req.json()
    if (!community_id || !bank_account_number || !bank_ifsc || !bank_account_holder) {
      return new Response(JSON.stringify({ error: "community_id, bank_account_number, bank_ifsc, bank_account_holder are required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const ifscUpper = bank_ifsc.toUpperCase()
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscUpper)) {
      return new Response(JSON.stringify({ error: "Invalid IFSC code format" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: community } = await supabase
      .from("communities")
      .select("owner_id, cashfree_beneficiary_id")
      .eq("id", community_id)
      .single()

    if (!community) return new Response(JSON.stringify({ error: "Community not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (community.owner_id !== user.id) return new Response(JSON.stringify({ error: "Only the community owner can set up payouts" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: existingBen } = await supabase
      .from("community_beneficiaries")
      .select("id")
      .eq("community_id", community_id)
      .eq("bank_account_number", "xxxxxx" + bank_account_number.slice(-4))
      .eq("bank_ifsc", ifscUpper)
      .maybeSingle()

    if (existingBen) {
      return new Response(JSON.stringify({ error: "This bank account is already added to this community." }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const beneficiaryId = crypto.randomUUID().replace(/-/g, "")
    const result = await cashfreePost("/beneficiary", {
      beneficiary_id: beneficiaryId,
      beneficiary_name: bank_account_holder,
      beneficiary_instrument_details: {
        bank_account_number: bank_account_number,
        bank_ifsc: ifscUpper,
      },
      beneficiary_contact_details: {
        beneficiary_email: user.email || "organizer@cluvo.com",
        beneficiary_phone: "9999999999",
        beneficiary_country_code: "+91",
        beneficiary_address: "N/A",
        beneficiary_city: "N/A",
        beneficiary_state: "N/A",
        beneficiary_postal_code: "000000",
      },
    })

    const { error: updateErr } = await supabase
      .from("communities")
      .update({ cashfree_beneficiary_id: beneficiaryId })
      .eq("id", community_id)

    if (updateErr) {
      console.error("Failed to update community cashfree_beneficiary_id:", updateErr)
      return new Response(JSON.stringify({ error: "Failed to save beneficiary. Please try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { error: deactivateErr } = await supabase
      .from("community_beneficiaries")
      .update({ is_active: false })
      .eq("community_id", community_id)

    if (deactivateErr) {
      await supabase.from("communities").update({ cashfree_beneficiary_id: null }).eq("id", community_id)
      console.error("Failed to deactivate old beneficiaries:", deactivateErr)
      return new Response(JSON.stringify({ error: "Failed to save beneficiary. Please try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { error: benInsertErr } = await supabase
      .from("community_beneficiaries")
      .insert({
        community_id,
        cashfree_beneficiary_id: beneficiaryId,
        account_holder: bank_account_holder,
        bank_account_number: "xxxxxx" + bank_account_number.slice(-4),
        bank_ifsc: ifscUpper,
        label: label || "Default Account",
        is_active: true,
      })
    if (benInsertErr) {
      await supabase.from("communities").update({ cashfree_beneficiary_id: null }).eq("id", community_id)
      console.error("Failed to insert community_beneficiary:", benInsertErr)
      return new Response(JSON.stringify({ error: "Failed to save beneficiary. Please try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

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
