import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const RAZORPAY_KEY_ID = requiredEnv("RAZORPAY_KEY_ID")
const RAZORPAY_KEY_SECRET = requiredEnv("RAZORPAY_KEY_SECRET")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

async function razorpayGet(path: string): Promise<any> {
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { description: `HTTP ${res.status}` } }))
    throw new Error(err.error?.description || `Razorpay API error (${res.status})`)
  }
  return res.json()
}

Deno.serve(async (_req) => {
  try {
    let totalActions = 0

    // --- Step 1: Check stale pending payments against Razorpay ---
    const { data: stalePayments, error: queryErr } = await supabase
      .from("payments")
      .select("id, razorpay_order_id, registration_id, coupon_id, created_at")
      .eq("status", "pending")
      .not("razorpay_order_id", "is", null)
      .is("deleted_at", null)
      .lt("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())

    if (queryErr) throw queryErr

    for (const pay of stalePayments || []) {
      const { data: alreadyConfirmed } = await supabase
        .from("payment_audit_log")
        .select("id")
        .eq("payment_id", pay.id)
        .eq("action", "payment_confirmed")
        .maybeSingle()

      if (alreadyConfirmed) continue

      try {
        const order = await razorpayGet(`orders/${pay.razorpay_order_id}`)

        const orderStatus: string = order.status
        const amountPaid: number = order.amount_paid || 0

        if (orderStatus === "paid" && amountPaid > 0) {
          const { data: paymentEntity } = await razorpayGet(`orders/${pay.razorpay_order_id}/payments`)
          const capturedPayment = paymentEntity?.items?.find((p: any) => p.status === "captured")
          if (capturedPayment) {
            await supabase.from("payments").update({
              razorpay_payment_id: capturedPayment.id,
            }).eq("id", pay.id)

            const { data: confirmResult, error: confirmErr } = await supabase
              .rpc("confirm_payment", { p_payment_id: pay.id })

            if (confirmErr) {
              console.error(`confirm_payment failed for ${pay.id}:`, confirmErr)
            } else if (confirmResult?.error) {
              console.error(`confirm_payment error for ${pay.id}:`, confirmResult.error)
            } else {
              console.log(`Reconciled payment ${pay.id} — captured via Razorpay, confirmed`)
              totalActions++
            }
          } else {
            await supabase.from("payments").update({
              status: "failed",
              updated_at: new Date().toISOString(),
            }).eq("id", pay.id)

            await supabase.from("registrations").update({
              status: "cancelled",
              updated_at: new Date().toISOString(),
            }).eq("id", pay.registration_id)

            await supabase.from("payment_audit_log").insert({
              action: "payment_expired",
              payment_id: pay.id,
              details: { razorpay_order_id: pay.razorpay_order_id, reconciled: true },
            })

            if (pay.coupon_id) {
              await supabase.rpc("release_coupon", { p_coupon_id: pay.coupon_id })
            }

            totalActions++
          }
        } else {
          await supabase.from("payments").update({
            status: "failed",
            updated_at: new Date().toISOString(),
          }).eq("id", pay.id)

          await supabase.from("registrations").update({
            status: "cancelled",
            updated_at: new Date().toISOString(),
          }).eq("id", pay.registration_id)

          await supabase.from("payment_audit_log").insert({
            action: "payment_expired",
            payment_id: pay.id,
            details: { razorpay_order_id: pay.razorpay_order_id, razorpay_status: orderStatus, reconciled: true },
          })

          if (pay.coupon_id) {
            await supabase.rpc("release_coupon", { p_coupon_id: pay.coupon_id })
          }

          totalActions++
        }
      } catch (err) {
        console.error(`Razorpay check failed for payment ${pay.id} — skipping, will retry next cycle:`, err)
      }
    }

    // --- Step 2: Cancel stale pending registrations without payments ---
    const { data: cancelResult } = await supabase.rpc("cancel_stale_pending")
    if (cancelResult) totalActions += cancelResult

    // --- Step 3: Refund stuck payout items (> 30 min old) ---
    // pending: never confirmed by Cashfree, always refundable
    // processing with a fallback wd_ id: Cashfree rejected/never confirmed the
    // transfer (no real cf_transfer_id) — refund. Processing with a real
    // Cashfree id is in-flight; the webhook settles it.
    const { data: stuckPayouts, error: payoutErr } = await supabase
      .from("payout_items")
      .select("id, status, cashfree_payout_id")
      .lt("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
      .in("status", ["pending", "processing"])

    if (payoutErr) throw payoutErr

    for (const payout of stuckPayouts || []) {
      if (payout.status === "processing" && !payout.cashfree_payout_id?.startsWith("wd_")) {
        continue
      }
      const { error: refundErr } = await supabase.rpc("refund_wallet", { p_payout_id: payout.id })
      if (refundErr) {
        console.error(`refund_wallet failed for payout ${payout.id}:`, refundErr)
      } else {
        totalActions++
      }
    }

    // --- Step 3b: Safety net — processing > 24h with no settlement (webhooks
    // never arrived or Cashfree rejected without notifying). Real transfers
    // settle in minutes-hours; 24h processing means something is wrong.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: staleProcessing, error: staleErr } = await supabase
      .from("payout_items")
      .select("id")
      .eq("status", "processing")
      .lt("created_at", dayAgo)

    if (staleErr) throw staleErr

    for (const payout of staleProcessing || []) {
      const { error: refundErr } = await supabase.rpc("refund_wallet", { p_payout_id: payout.id })
      if (refundErr) {
        console.error(`refund_wallet failed for stale processing payout ${payout.id}:`, refundErr)
      } else {
        totalActions++
      }
    }

    // --- Step 4: Cleanup old processed webhook records (keep last 7 days) ---
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: deleteResult } = await supabase
      .from("processed_webhooks")
      .delete()
      .lt("processed_at", weekAgo)

    if (deleteResult) totalActions++

    return new Response(JSON.stringify({ reconciled: totalActions }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    console.error("reconcile-payments error:", err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})