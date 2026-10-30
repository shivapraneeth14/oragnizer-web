import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { logError } from "../_shared/logger.ts"
import { getCorsHeaders } from "../_shared/cors.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
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

    const cleanAccount = String(bank_account_number).trim()
    if (!/^\d{9,18}$/.test(cleanAccount)) {
      return new Response(JSON.stringify({ error: "Bank account number must be between 9 and 18 digits" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const ifscUpper = String(bank_ifsc).trim().toUpperCase()
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscUpper)) {
      return new Response(JSON.stringify({ error: "Invalid IFSC code format" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const cleanHolder = String(bank_account_holder).trim()
    if (cleanHolder.length === 0 || cleanHolder.length > 100) {
      return new Response(JSON.stringify({ error: "Account holder name must be between 1 and 100 characters" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: community } = await supabase
      .from("communities")
      .select("owner_id, cashfree_beneficiary_id")
      .eq("id", community_id)
      .single()

    if (!community) return new Response(JSON.stringify({ error: "Community not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (community.owner_id !== user.id) return new Response(JSON.stringify({ error: "Only the community owner can set up payouts" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const maskedNumber = "xxxxxx" + cleanAccount.slice(-4)
    const { data: existingBen } = await supabase
      .from("community_beneficiaries")
      .select("id")
      .eq("community_id", community_id)
      .eq("bank_account_number", maskedNumber)
      .eq("bank_ifsc", ifscUpper)
      .maybeSingle()

    if (existingBen) {
      return new Response(JSON.stringify({ error: "This bank account is already added to this community." }), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    // Generate internal beneficiary ID decoupled from external providers
    const beneficiaryId = crypto.randomUUID().replace(/-/g, "")

    const { error: updateErr } = await supabase
      .from("communities")
      .update({ cashfree_beneficiary_id: beneficiaryId })
      .eq("id", community_id)

    if (updateErr) {
      logError("create-beneficiary update", updateErr)
      return new Response(JSON.stringify({ error: "Failed to save beneficiary. Please try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { error: deactivateErr } = await supabase
      .from("community_beneficiaries")
      .update({ is_active: false })
      .eq("community_id", community_id)

    if (deactivateErr) {
      await supabase.from("communities").update({ cashfree_beneficiary_id: null }).eq("id", community_id)
      logError("create-beneficiary deactivate", deactivateErr)
      return new Response(JSON.stringify({ error: "Failed to save beneficiary. Please try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { error: benInsertErr } = await supabase
      .from("community_beneficiaries")
      .insert({
        community_id,
        cashfree_beneficiary_id: beneficiaryId,
        account_holder: cleanHolder,
        bank_account_number: maskedNumber,
        bank_ifsc: ifscUpper,
        label: label ? String(label).trim() : "Default Account",
        is_active: true,
      })

    if (benInsertErr) {
      await supabase.from("communities").update({ cashfree_beneficiary_id: null }).eq("id", community_id)
      logError("create-beneficiary insert", benInsertErr)
      return new Response(JSON.stringify({ error: "Failed to save beneficiary. Please try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    await supabase.from("payment_audit_log").insert({
      action: "beneficiary_created",
      details: {
        community_id,
        beneficiary_id: beneficiaryId,
      },
    })

    return new Response(JSON.stringify({ beneficiary_id: beneficiaryId }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    logError("create-beneficiary", err)
    return new Response(JSON.stringify({ error: "Something went wrong. Please check the details and try again." }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
