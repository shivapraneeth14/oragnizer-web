import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { cashfreePost } from "../_shared/cashfree.ts"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const MIN_WITHDRAWAL_PAISE = 100
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

    const rl = await checkRateLimit(user.id, "withdraw-wallet")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { community_id, amount } = await req.json()
    if (!community_id || !amount || amount <= 0) {
      return new Response(JSON.stringify({ error: "community_id and amount (> 0) are required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }
    if (amount < MIN_WITHDRAWAL_PAISE) {
      return new Response(JSON.stringify({ error: `Minimum withdrawal amount is ₹${(MIN_WITHDRAWAL_PAISE / 100).toFixed(0)} (${MIN_WITHDRAWAL_PAISE} paise)` }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const { data: community } = await supabase
      .from("communities")
      .select("owner_id")
      .eq("id", community_id)
      .single()

    if (!community) return new Response(JSON.stringify({ error: "Community not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })
    if (community.owner_id !== user.id) return new Response(JSON.stringify({ error: "Only the community owner can withdraw" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: activeBeneficiary } = await supabase
      .from("community_beneficiaries")
      .select("id, cashfree_beneficiary_id")
      .eq("community_id", community_id)
      .eq("is_active", true)
      .single()

    if (!activeBeneficiary) return new Response(JSON.stringify({ error: "No bank account set up. Add bank details first." }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: withdrawResult, error: rpcError } = await supabase
      .rpc("initiate_wallet_withdrawal", {
        p_community_id: community_id,
        p_amount: amount,
      })

    if (rpcError) throw rpcError
    if (withdrawResult?.error) {
      return new Response(JSON.stringify({ error: withdrawResult.error }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const payoutId = withdrawResult.payout_id
    const transferId = `wd_${payoutId.replace(/-/g, "")}`
    let cashfreeResponse: any

    try {
      cashfreeResponse = await cashfreePost("/transfers", {
        transfer_id: transferId,
        transfer_amount: amount / 100,
        transfer_mode: "banktransfer",
        transfer_currency: "INR",
        beneficiary_details: {
          beneficiary_id: activeBeneficiary.cashfree_beneficiary_id,
        },
      })
    } catch (cfErr) {
      const cfMessage = cfErr instanceof Error ? cfErr.message : String(cfErr)
      await supabase.from("payment_audit_log").insert({
        action: "withdrawal_failed",
        details: {
          payout_id: payoutId,
          community_id,
          amount,
          error: cfMessage,
        },
      })
      const { error: refundErr } = await supabase.rpc("refund_wallet", { p_payout_id: payoutId })
      if (refundErr) console.error("refund_wallet failed after Cashfree error:", refundErr)
      throw cfErr
    }

    await supabase
      .from("payout_items")
      .update({
        status: "processing",
        beneficiary_id: activeBeneficiary.id,
        cashfree_payout_id: cashfreeResponse?.cf_transfer_id || transferId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", payoutId)

    await supabase.from("payment_audit_log").insert({
      action: "withdrawal_submitted",
      details: {
        payout_id: payoutId,
        community_id,
        amount,
        cashfree_response: cashfreeResponse,
      },
    })

    return new Response(JSON.stringify({
      payout_id: payoutId,
      amount,
      status: "processing",
      cashfree_reference: cashfreeResponse?.cf_transfer_id,
    }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    console.error(err)
    const msg = err instanceof Error ? err.message : "Something went wrong"
    return new Response(JSON.stringify({ error: msg }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
