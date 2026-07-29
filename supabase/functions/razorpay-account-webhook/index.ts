import { createClient } from "jsr:@supabase/supabase-js@2"
import { crypto } from "jsr:@std/crypto@0.224"
import { encodeHex } from "jsr:@std/encoding@0.224/hex"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const RAZORPAY_WEBHOOK_SECRET = Deno.env.get("RAZORPAY_WEBHOOK_SECRET")!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function verifySignature(payload: string, signature: string, secret: string): Promise<boolean> {
  const key = new TextEncoder().encode(secret)
  const data = new TextEncoder().encode(payload)
  const hmac = await crypto.subtle.sign("HMAC", key, data)
  const expected = encodeHex(hmac)
  return expected === signature
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } })

  try {
    const body = await req.text()
    const ip = getClientIp(req)
    const rl = await checkRateLimit(ip, "razorpay-account-webhook")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const signature = req.headers.get("x-razorpay-signature")
    if (!signature) return new Response("Missing signature", { status: 401 })

    if (!await verifySignature(body, signature, RAZORPAY_WEBHOOK_SECRET)) {
      return new Response("Invalid signature", { status: 401 })
    }

    const payload = JSON.parse(body)

    // Replay protection
    if (payload.created_at) {
      const age = Date.now() - new Date(payload.created_at * 1000).getTime()
      if (age > 5 * 60 * 1000) return new Response("Webhook too old", { status: 400 })
    }

    const event = payload.event
    const accountId = payload.payload?.account?.id || payload.payload?.linked_account?.id

    if (!accountId) return new Response("Missing account_id", { status: 400 })

    let newStatus: string
    switch (event) {
      case "account.activated":
        newStatus = "activated"
        break
      case "account.rejected":
        newStatus = "rejected"
        break
      default:
        return new Response("Unhandled event", { status: 200 })
    }

    // Update community status
    const { data: community } = await supabase
      .from("communities")
      .update({ razorpay_account_status: newStatus })
      .eq("razorpay_account_id", accountId)
      .select("id")
      .single()

    if (!community) return new Response("Community not found", { status: 404 })

    // Audit log
    await supabase.from("payment_audit_log").insert({
      action: `account_${newStatus}`,
      details: { event, account_id: accountId, community_id: community.id },
    })

    // If activated, trigger immediate reconciliation of pending transfers
    if (newStatus === "activated") {
      await supabase.rpc("reconcile_payments")
    }

    return new Response("OK", { status: 200 })
  } catch (err) {
    console.error(err)
    return new Response("Internal error", { status: 500 })
  }
})
