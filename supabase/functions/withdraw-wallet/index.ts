import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { cashfreePost, cashfreeGet } from "../_shared/cashfree.ts"
import { isDeletionPending, deletionPendingResponse } from "../_shared/deletion.ts"
import { logError } from "../_shared/logger.ts"
import { getCorsHeaders } from "../_shared/cors.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const MIN_WITHDRAWAL = 100
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

    const rl = await checkRateLimit(user.id, "withdraw-wallet")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    if (await isDeletionPending(supabase, user.id)) return deletionPendingResponse()

    const { community_id, amount } = await req.json()
    if (!community_id || !amount || amount <= 0 || !Number.isInteger(amount)) {
      return new Response(JSON.stringify({ error: "community_id and amount (> 0) are required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }
    if (amount < MIN_WITHDRAWAL * 100) {
      return new Response(JSON.stringify({ error: `Minimum withdrawal amount is ₹${MIN_WITHDRAWAL}` }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
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

      // The POST may have failed after Cashfree already accepted the transfer
      // (timeout / dropped response). Verify before refunding so we never both
      // pay out and refund the same withdrawal.
      let transferKnown = false
      try {
        const check = await cashfreeGet(`/getTransferStatus?transferId=${encodeURIComponent(transferId)}`)
        const inner = check?.data?.transfer ?? check?.data ?? check ?? {}
        if (inner?.status) transferKnown = true
      } catch {
        // Not found at Cashfree → the transfer was never created → safe to refund.
      }

      await supabase.from("payment_audit_log").insert({
        action: transferKnown ? "withdrawal_submit_ambiguous" : "withdrawal_failed",
        details: {
          payout_id: payoutId,
          community_id,
          amount,
          error: cfMessage,
          transfer_known_at_cashfree: transferKnown,
        },
      })

      if (transferKnown) {
        // Cashfree has it — keep the payout processing and let the sync /
        // reconcile pipeline settle it, rather than refunding now.
        await supabase
          .from("payout_items")
          .update({
            status: "processing",
            beneficiary_id: activeBeneficiary.id,
            cashfree_payout_id: transferId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", payoutId)

        return new Response(JSON.stringify({
          payout_id: payoutId,
          amount,
          status: "processing",
          cashfree_reference: transferId,
          note: "Transfer accepted by Cashfree; status will be confirmed shortly",
        }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
      }

      const { error: refundErr } = await supabase.rpc("refund_wallet", { p_payout_id: payoutId })
      if (refundErr) logError("withdraw-wallet refund", refundErr)
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
        // Store only the transfer reference — never the raw Cashfree
        // response, which can contain bank account numbers and IFSCs.
        cashfree_transfer_id: cashfreeResponse?.cf_transfer_id || transferId,
      },
    })

    return new Response(JSON.stringify({
      payout_id: payoutId,
      amount,
      status: "processing",
      cashfree_reference: cashfreeResponse?.cf_transfer_id,
    }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    logError("withdraw-wallet", err)
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
