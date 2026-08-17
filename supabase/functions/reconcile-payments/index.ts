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

async function razorpayPost(path: string, body: any): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, data }
}

// Razorpay refund entity status -> our payments.refund_status domain.
// Mirror of the map in verify-payment-webhook, kept here so this function
// never assumes a refund completed just because Razorpay accepted it.
const REFUND_STATUS_MAP: Record<string, string> = {
  created: "queued",
  pending: "pending",
  queued: "queued",
  initiated: "pending",
  processed: "processed",
  failed: "failed",
  cancelled: "failed",
}

// Claw back the organizer's share of a refunded payment from the community
// wallet and reverse the platform commission record. Mirrors the webhook
// path: the customer is refunded in FULL (fee included), so the fee record
// for this transaction is zeroed rather than kept.
async function rebalanceRefund(
  payment: { id: string; registration_id: string; amount: number },
  reason: string,
): Promise<void> {
  const { data: registration } = await supabase
    .from("registrations")
    .select("event_id")
    .eq("id", payment.registration_id)
    .single()
  if (!registration) return

  const { data: event } = await supabase
    .from("events")
    .select("id, community_id")
    .eq("id", registration.event_id)
    .single()
  if (!event) return

  const { data: community } = await supabase
    .from("communities")
    .select("id, commission_percent")
    .eq("id", event.community_id)
    .single()
  if (!community) return

  const commissionPercent = community.commission_percent ?? 10
  const platformFee = Math.floor(Number(payment.amount) * Number(commissionPercent) / 100)
  const organizerShare = Number(payment.amount) - platformFee

  const { data: debitResult, error: debitError } = await supabase.rpc("debit_wallet", {
    p_community_id: community.id,
    p_amount: organizerShare,
    p_reason: `${reason}_refund`,
    p_event_id: event.id,
  })
  if (debitError || debitResult?.error) {
    throw new Error(debitResult?.error || debitError?.message || "Wallet debit failed")
  }

  if (platformFee > 0) {
    await supabase.from("payment_audit_log").insert({
      action: "commission_reversed",
      payment_id: payment.id,
      details: {
        commission_amount: platformFee,
        reason,
        note: `Platform commission zeroed — customer refunded the full ₹${(Number(payment.amount) / 100).toFixed(0)} including our fee`,
      },
    })
  }
}

// Attempts a Razorpay refund for a payment that must go back to the customer.
async function processRefund(paymentId: string, amount: number, reason: string): Promise<void> {
  const { data: payment } = await supabase
    .from("payments")
    .select("id, razorpay_payment_id, refund_attempt_count, registration_id, amount")
    .eq("id", paymentId)
    .single()

  if (!payment?.razorpay_payment_id) {
    await supabase.from("payments").update({ refund_status: "failed" }).eq("id", paymentId)
    throw new Error(`No razorpay_payment_id for ${paymentId}`)
  }

  const result = await razorpayPost(`payments/${payment.razorpay_payment_id}/refund`, {
    amount,
    receipt: `ref_${paymentId}`,
  })

  if (result.ok) {
    const refund = result.data
    const mappedStatus = REFUND_STATUS_MAP[refund.status] || "pending"

    // Record the truthful refund state FIRST (Razorpay accepted it), then
    // rebalance the organizer wallet. If the clawback fails, it is surfaced
    // in payment_audit_log for manual follow-up instead of being silently
    // swallowed or retried into a double refund.
    await supabase.from("payments").update({
      status: "refunded",
      refund_status: mappedStatus,
      razorpay_refund_id: refund.id,
      refunded_amount: refund.amount,
    }).eq("id", paymentId)
    await supabase.from("payment_audit_log").insert({
      action: "refund_issued",
      payment_id: paymentId,
      details: { refund_id: refund.id, amount, reason, refund_status: mappedStatus },
    })

    try {
      await rebalanceRefund(payment, reason)
    } catch (clawbackErr) {
      await supabase.from("payment_audit_log").insert({
        action: "refund_wallet_debit_failed",
        payment_id: paymentId,
        details: {
          refund_id: refund.id,
          amount,
          reason,
          error: (clawbackErr as Error).message,
          note: "Customer refunded but organizer wallet clawback failed - manual follow-up required",
        },
      })
    }
    return
  }

  const errBody = result.data
  const errorDesc = errBody.error?.description || errBody.message || "Unknown Razorpay error"
  const alreadyProcessed = errBody.error?.code === "BAD_REQUEST_ERROR"
    && /duplicate\s+receipt/i.test(errorDesc)

  if (alreadyProcessed) {
    // "Duplicate receipt" means SOME refund with ref_{paymentId} exists on
    // this payment — but it may have FAILED (Razorpay keeps a failed
    // refund's receipt reserved, so the receipt alone proves nothing).
    // Check the actual refund list before deciding.
    const existingRefunds = await razorpayGet(`payments/${payment.razorpay_payment_id}/refunds`).catch(() => ({ items: [] }))
    const ours = (existingRefunds?.items ?? []).filter((r: any) => r.receipt === `ref_${paymentId}`)
    const live = ours.find((r: any) => r.status !== "cancelled")

    if (live) {
      // A previous flow already refunded this payment — adopt its real
      // state. The flow that created it ran the wallet clawback itself, so
      // no rebalance happens here (matching the webhook duplicate branch).
      const liveStatus = REFUND_STATUS_MAP[live.status] || "pending"
      await supabase.from("payments").update({
        status: "refunded",
        refund_status: liveStatus,
        razorpay_refund_id: live.id,
        refunded_amount: live.amount,
      }).eq("id", paymentId)
      await supabase.from("payment_audit_log").insert({
        action: "refund_already_processed",
        payment_id: paymentId,
        details: { refund_id: live.id, refund_status: liveStatus, reason },
      })
      return
    }

    // The receipt was burned by a failed/cancelled attempt (or the refund
    // list is empty) — RETRY once with a fresh receipt instead of marking
    // the payment refunded while the customer got nothing back.
    const attempt = (payment.refund_attempt_count ?? 0) + 1
    const retry = await razorpayPost(`payments/${payment.razorpay_payment_id}/refund`, {
      amount,
      receipt: `ref_${paymentId}_${attempt}`,
    })

    if (retry.ok) {
      const refund = retry.data
      const mappedStatus = REFUND_STATUS_MAP[refund.status] || "pending"
      await supabase.from("payments").update({
        status: "refunded",
        refund_status: mappedStatus,
        refund_attempt_count: attempt,
        razorpay_refund_id: refund.id,
        refunded_amount: refund.amount,
      }).eq("id", paymentId)
      await supabase.from("payment_audit_log").insert({
        action: "refund_issued",
        payment_id: paymentId,
        details: { refund_id: refund.id, amount, reason, refund_status: mappedStatus, retried_receipt: true },
      })
      try {
        await rebalanceRefund(payment, reason)
      } catch (clawbackErr) {
        await supabase.from("payment_audit_log").insert({
          action: "refund_wallet_debit_failed",
          payment_id: paymentId,
          details: {
            refund_id: refund.id,
            amount,
            reason,
            error: (clawbackErr as Error).message,
            note: "Customer refunded but organizer wallet clawback failed - manual follow-up required",
          },
        })
      }
      return
    }

    const retryErrBody = retry.data
    const retryErrorDesc = retryErrBody.error?.description || retryErrBody.message || "Unknown Razorpay error"
    const attempts = attempt + 1
    await supabase.from("payments").update({
      refund_status: "failed",
      refund_attempt_count: attempts,
    }).eq("id", paymentId)
    await supabase.from("payment_audit_log").insert({
      action: "refund_failed",
      payment_id: paymentId,
      details: { error: retryErrorDesc, razorpay_response: retryErrBody, reason },
    })
    throw new Error(`Refund retry failed for payment ${paymentId}: ${retryErrorDesc}`)
  }

  const attempts = (payment.refund_attempt_count ?? 0) + 1
  await supabase.from("payments").update({
    refund_status: "failed",
    refund_attempt_count: attempts,
  }).eq("id", paymentId)
  await supabase.from("payment_audit_log").insert({
    action: "refund_failed",
    payment_id: paymentId,
    details: { error: errorDesc, razorpay_response: errBody, reason },
  })
  throw new Error(`Refund failed for payment ${paymentId}: ${errorDesc}`)
}

// Refunds owed to customers whose payment reached us but could never be
// confirmed (e.g. event cancelled after capture). Capped retries — the
// webhook keeps the real refund state in sync; 5 failed attempts flag the
// payment for manual follow-up via the refund_retry_exhausted audit action.
async function retryPendingRefunds(): Promise<number> {
  const { data: dueRefunds, error: dueErr } = await supabase
    .from("payments")
    .select("id, refund_status, refund_attempt_count")
    // 'refunded': cancellation refund failed. 'failed': money captured but
    // never confirmed (event cancelled) - owed back to the customer.
    .in("status", ["refunded", "failed"])
    .in("refund_status", ["requested", "pending", "failed", "queued"])
    .lt("refund_attempt_count", 5)
    // Recooldown: skip rows being re-ordered by create-payment (it bumps
    // updated_at) so we never refund a freshly-captured payment twice.
    .lt("updated_at", new Date(Date.now() - 15 * 60 * 1000).toISOString())

  if (dueErr) throw dueErr

  let handled = 0
  for (const pay of dueRefunds || []) {
    try {
      const { data: payment } = await supabase
        .from("payments")
        .select("id, amount")
        .eq("id", pay.id)
        .single()
      if (!payment) continue

      if (pay.refund_status === "queued" && pay.refund_attempt_count < 5) {
        // Refund already accepted by Razorpay — sync its real state instead
        // of double-refunding. Find it via razorpay_refund_id.
        const { data: known } = await supabase
          .from("payments")
          .select("razorpay_refund_id")
          .eq("id", pay.id)
          .single()
        if (known?.razorpay_refund_id) {
          const refund = await razorpayGet(`refunds/${known.razorpay_refund_id}`).catch(() => null)
          if (refund?.status === "processed") {
            await supabase.from("payments").update({
              refund_status: "processed",
              status: "refunded",
              refunded_amount: refund.amount,
            }).eq("id", pay.id)
            handled++
            continue
          }
          if (refund?.status === "failed" || refund?.status === "cancelled") {
            await supabase.from("payments").update({
              refund_status: "failed",
              refund_attempt_count: (pay.refund_attempt_count ?? 0) + 1,
            }).eq("id", pay.id)
          }
        }
        continue
      }

      await processRefund(pay.id, payment.amount, "reconcile_refund_retry")
      handled++
    } catch (err) {
      console.error(`Refund retry failed for ${pay.id}:`, err)
      const { data: after } = await supabase
        .from("payments")
        .select("refund_attempt_count")
        .eq("id", pay.id)
        .single()
      const attempts = after?.refund_attempt_count ?? 1
      if (attempts >= 5) {
        await supabase.from("payment_audit_log").insert({
          action: "refund_retry_exhausted",
          payment_id: pay.id,
          details: { note: "5 refund attempts failed - manual follow-up required" },
        })
      }
    }
  }
  return handled
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
            } else if (confirmResult?.action === "refund_required") {
              // Money was captured but the event was cancelled (or capacity
              // vanished). Refund now — the customer keeps nothing.
              try {
                await processRefund(pay.id, capturedPayment.amount, "reconcile_event_cancelled")
                totalActions++
              } catch (refundErr) {
                console.error(`Auto-refund failed for ${pay.id}:`, refundErr)
              }
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

    // --- Step 3c: Retry refunds owed to customers (pending/failed/queued
    // on our side), capped at 5 attempts -> refund_retry_exhausted flags the
    // payment for manual follow-up. Refund webhooks keep the truth in sync.
    totalActions += await retryPendingRefunds()

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