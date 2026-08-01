import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { verifyCashfreeWebhook } from "../_shared/cashfree.ts"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const CASHFREE_WEBHOOK_SECRET = Deno.env.get("CASHFREE_WEBHOOK_SECRET")!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } })

  try {
    const rawBody = await req.text()
    const ip = getClientIp(req)
    const rl = await checkRateLimit(ip, "cashfree-webhook")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const signature = req.headers.get("x-webhook-signature")
    if (!signature) return new Response("Missing signature", { status: 401 })

    if (!verifyCashfreeWebhook(rawBody, signature, CASHFREE_WEBHOOK_SECRET)) {
      return new Response("Invalid signature", { status: 401 })
    }

    const payload = JSON.parse(rawBody)

    if (payload.created_at) {
      const webhookTime = new Date(payload.created_at * 1000)
      const age = Date.now() - webhookTime.getTime()
      if (age > 5 * 60 * 1000) {
        return new Response("Webhook too old", { status: 400 })
      }
    }

    if (payload.type !== "PAYOUT_STATUS_CHANGE") {
      return new Response("Unhandled event", { status: 200 })
    }

    const cashfreePayoutId = payload.data?.referenceId || payload.data?.transferId
    if (!cashfreePayoutId) return new Response("Missing payout reference", { status: 400 })

    // Webhook deduplication: use cashfree_payout_id + status as unique key
    const webhookId = `cashfree_${cashfreePayoutId}_${payload.data?.status || "unknown"}`
    const { data: alreadyProcessed } = await supabase
      .rpc("try_process_webhook", {
        p_webhook_id: webhookId,
        p_provider: "cashfree",
        p_event_type: payload.type,
      })
    if (alreadyProcessed === false) {
      return new Response("Already processed", { status: 200 })
    }

    const { data: payout } = await supabase
      .from("payout_items")
      .select("id, status, community_id, amount")
      .eq("cashfree_payout_id", cashfreePayoutId)
      .maybeSingle()

    if (!payout) return new Response("Payout not found", { status: 404 })

    const newStatus = payload.data?.status
    if (newStatus === "SUCCESS") {
      if (payout.status === "success") return new Response("Already processed", { status: 200 })

      await supabase
        .from("payout_items")
        .update({ status: "success", updated_at: new Date().toISOString() })
        .eq("id", payout.id)

      await supabase.from("payment_audit_log").insert({
        action: "payout_success",
        details: { payout_id: payout.id, community_id: payout.community_id, amount: payout.amount },
      })
    } else if (["FAILED", "REJECTED", "REVERSED"].includes(newStatus)) {
      await supabase.rpc("refund_wallet", { p_payout_id: payout.id })

      await supabase.from("payment_audit_log").insert({
        action: "payout_failed",
        details: { payout_id: payout.id, community_id: payout.community_id, amount: payout.amount, status: newStatus },
      })
    }

    return new Response("OK", { status: 200 })
  } catch (err) {
    console.error(err)
    return new Response("Internal error", { status: 500 })
  }
})
