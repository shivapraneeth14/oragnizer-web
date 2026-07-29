import { createClient } from "jsr:@supabase/supabase-js@2"
import { createHmac } from "node:crypto"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const RAZORPAY_WEBHOOK_SECRET = Deno.env.get("RAZORPAY_WEBHOOK_SECRET")!
const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID")!
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET")!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const hmac = createHmac("sha256", secret)
  hmac.update(payload)
  const expected = hmac.digest("hex")
  return expected === signature
}

async function processRefund(paymentId: string, amount: number) {
  const { data: payment } = await supabase.from("payments").select("razorpay_payment_id").eq("id", paymentId).single()
  if (!payment?.razorpay_payment_id) return

  const res = await fetch(`https://api.razorpay.com/v1/payments/${payment.razorpay_payment_id}/refund`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
    },
    body: JSON.stringify({ amount }),
  })

  if (res.ok) {
    const refund = await res.json()
    await supabase.from("payments").update({
      status: "refunded",
      refund_status: "processed",
    }).eq("id", paymentId)

    await supabase.from("payment_audit_log").insert({
      action: "refund_issued",
      payment_id: paymentId,
      details: { refund_id: refund.id, amount },
    })
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } })

  try {
    const body = await req.text()
    const ip = getClientIp(req)
    const rl = await checkRateLimit(ip, "verify-payment-webhook")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const signature = req.headers.get("x-razorpay-signature")
    if (!signature) return new Response("Missing signature", { status: 401 })

    // Verify HMAC
    if (!await verifySignature(body, signature, RAZORPAY_WEBHOOK_SECRET)) {
      return new Response("Invalid signature", { status: 401 })
    }

    const payload = JSON.parse(body)

    // Replay protection — reject webhooks older than 5 minutes
    if (payload.created_at) {
      const webhookTime = new Date(payload.created_at * 1000)
      const age = Date.now() - webhookTime.getTime()
      if (age > 5 * 60 * 1000) {
        return new Response("Webhook too old", { status: 400 })
      }
    }

    // Only handle payment.captured
    if (payload.event !== "payment.captured") {
      return new Response("Unhandled event", { status: 200 })
    }

    const payment = payload.payload?.payment?.entity
    if (!payment?.order_id) return new Response("Missing order_id", { status: 400 })

    // Find payments row by razorpay_order_id
    const { data: paymentRow } = await supabase
      .from("payments")
      .select("id, status")
      .eq("razorpay_order_id", payment.order_id)
      .maybeSingle()

    if (!paymentRow) {
      return new Response("Order not found", { status: 404 })
    }

    // Idempotency — already processed
    if (paymentRow.status === "success") {
      return new Response("Already processed", { status: 200 })
    }

    // Update payment with razorpay_payment_id
    await supabase.from("payments").update({
      razorpay_payment_id: payment.id,
    }).eq("id", paymentRow.id)

    // Run confirm_payment RPC (atomic transaction)
    const { data: confirmResult, error: confirmErr } = await supabase
      .rpc("confirm_payment", { p_payment_id: paymentRow.id })

    if (confirmErr) throw confirmErr

    if (confirmResult?.action === "refund_required") {
      // Capacity full — auto-refund
      await processRefund(paymentRow.id, payment.amount)
      return new Response("Refund issued", { status: 200 })
    }

    if (confirmResult?.error) {
      throw new Error(confirmResult.error)
    }

    // If transfer is pending and organizer account is activated, trigger transfer via Razorpay
    if (confirmResult?.transfer_id) {
      const { data: transfer } = await supabase
        .from("payment_transfers")
        .select("id, community_id, amount, status")
        .eq("id", confirmResult.transfer_id)
        .single()

      if (transfer && transfer.status === "pending") {
        const { data: community } = await supabase
          .from("communities")
          .select("razorpay_account_id, razorpay_account_status")
          .eq("id", transfer.community_id)
          .single()

        if (community?.razorpay_account_status === "activated" && community?.razorpay_account_id) {
          try {
            const transferRes = await fetch(`https://api.razorpay.com/v1/payments/${payment.id}/transfers`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
              },
              body: JSON.stringify({
                transfers: [{
                  account: community.razorpay_account_id,
                  amount: transfer.amount,
                  currency: "INR",
                }],
              }),
            })

            if (transferRes.ok) {
              const transferData = await transferRes.json()
              const transferId = transferData?.transfers?.[0]?.id
              await supabase.from("payment_transfers").update({
                status: "processed",
                razorpay_transfer_id: transferId,
                updated_at: new Date().toISOString(),
              }).eq("id", transfer.id)

              await supabase.from("payment_audit_log").insert({
                action: "transfer_processed",
                payment_id: paymentRow.id,
                transfer_id: transfer.id,
                details: { razorpay_transfer_id: transferId },
              })
            }
          } catch (transferErr) {
            console.error("Transfer failed:", transferErr)
            // Transfer will be retried by reconciliation job
          }
        }
      }
    }

    return new Response("OK", { status: 200 })
  } catch (err) {
    console.error(err)
    console.error("verify-payment-webhook error:", err)
    const errMsg = err instanceof Error ? err.message : typeof err === "object" ? JSON.stringify(err, Object.getOwnPropertyNames(err)) : String(err)
    return new Response("Internal error: " + errMsg, { status: 500 })
  }
})
