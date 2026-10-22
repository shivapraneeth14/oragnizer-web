import { optionalEnv, requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { recordAlert } from "../_shared/alerts.ts"
import { safeEqual } from "../_shared/crypto.ts"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { attemptRefund, refundRetryPlan } from "../_shared/refunds.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const RAZORPAY_KEY_ID = requiredEnv("RAZORPAY_KEY_ID")
const RAZORPAY_KEY_SECRET = requiredEnv("RAZORPAY_KEY_SECRET")
const supabase = createClient(supabaseUrl, supabaseServiceKey)
const RECONCILE_SECRET = optionalEnv("RECONCILE_SECRET")

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-reconcile-secret",
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

// Attempts a Razorpay refund for a payment that must go back to the customer.
// Claim-guarded by _shared/refunds.attemptRefund: concurrent callers (cancel
// flows, this job) serialize on the payment and exactly one issues the refund;
// the wallet clawback runs once inside complete_payment_refund.
async function processRefund(paymentId: string, amount: number, reason: string): Promise<void> {
  const { data: payment } = await supabase
    .from("payments")
    .select("id, razorpay_payment_id, refund_attempt_count, registration_id, amount, platform_fee, organizer_share")
    .eq("id", paymentId)
    .single()

  if (!payment) return

  // attemptRefund throws when the payment is not refundable or the provider
  // refused after a provider re-check; conflict/already_refunded are clean
  // no-ops so concurrent refunders never double-refund.
  const outcome = await attemptRefund(supabase, payment, amount, reason)
  if (outcome.status === "conflict" || outcome.status === "already_refunded") return

  if (Number(payment.platform_fee ?? 0) > 0) {
    await supabase.from("payment_audit_log").insert({
      action: "commission_reversed",
      payment_id: payment.id,
      details: {
        commission_amount: payment.platform_fee,
        reason,
        note: `Platform commission zeroed — customer refunded the full ₹${(Number(payment.amount) / 100).toFixed(0)} including our fee`,
      },
    })
  }
}

// Refunds owed to customers whose payment reached us but could never be
// confirmed (e.g. event cancelled after capture). Capped retries — the
// webhook keeps the real refund state in sync; 5 failed attempts flag the
// payment for manual follow-up via the refund_retry_exhausted audit action.
async function retryPendingRefunds(): Promise<number> {
  const { data: dueRefunds, error: dueErr } = await supabase
    .from("payments")
    .select("id, refund_status, refund_attempt_count, razorpay_refund_id, amount, refunded_amount, refund_amount_due, refund_reason")
    // 'refunded': cancellation refund failed. 'failed': money captured but
    // never confirmed (event cancelled) - owed back to the customer.
    // 'success': money captured AND refund attempt already failed - the
    // retry must NOT skip these, or the customer is stranded forever.
    .in("status", ["refunded", "failed", "success"])
    .in("refund_status", ["requested", "pending", "failed", "queued"])
    .lt("refund_attempt_count", 5)
    // Recooldown: skip rows being re-ordered by create-payment (it bumps
    // updated_at) so we never refund a freshly-captured payment twice.
    .lt("updated_at", new Date(Date.now() - 15 * 60 * 1000).toISOString())

  if (dueErr) throw dueErr

  let handled = 0
  for (const pay of dueRefunds || []) {
    try {
      // A refund already accepted by Razorpay (we hold its id) is synced from
      // the provider, never re-issued. Without this, a refund the provider is
      // still settling ('pending'/'initiated') - or one an older flow left as
      // 'pending' - stays pending forever: claim_payment_refund answers
      // already_refunded, so processRefund would be a silent no-op.
      const inFlight = pay.refund_status === "queued" ||
        pay.refund_status === "pending" ||
        pay.refund_status === "requested"
      if (inFlight && pay.razorpay_refund_id) {
        const refund = await razorpayGet(`refunds/${pay.razorpay_refund_id}`).catch(() => null)
        if (refund?.status === "processed") {
          await supabase.from("payments").update({
            refund_status: "processed",
            status: "refunded",
            refunded_amount: refund.amount ?? pay.refunded_amount ?? pay.amount,
            refund_amount_due: null,
            refund_claim_state: "issued",
          }).eq("id", pay.id)
          handled++
          continue
        }
        if (refund?.status === "failed" || refund?.status === "cancelled") {
          await supabase.from("payments").update({
            refund_status: "failed",
            refund_attempt_count: (pay.refund_attempt_count ?? 0) + 1,
          }).eq("id", pay.id)
          handled++
          continue
        }
        // Still pending/initiated at Razorpay - leave it, retry next cycle.
        continue
      }

      // No provider refund yet, or the last one failed: issue/retry one.
      // POLICY INTEGRITY: refundRetryPlan uses the persisted owed amount and
      // cancellation type — never re-derives. A failed customer-cancellation
      // refund retries exactly the owed ticket (platform fee excluded); an
      // organizer-cancellation refund retries the full amount.
      const { amount: retryAmount, reason: retryReason } = refundRetryPlan(pay)
      await processRefund(pay.id, retryAmount, retryReason)
      handled++
    } catch (err) {
      console.error(`Refund retry failed for ${pay.id}:`, err)
      await recordAlert(supabase, {
        severity: "warning",
        category: "payment",
        title: "Refund retry failed for payment",
        details: { payment_id: pay.id, error: err instanceof Error ? err.message : String(err) },
      })
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } })

  // Throttle before the secret check so a flood of bad-secret calls cannot spam
  // the critical alert stream. The legitimate cron runs once per few minutes.
  const rl = await checkRateLimit(getClientIp(req), "reconcile-payments")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  const presentedSecret = req.headers.get("x-reconcile-secret") ?? ""
  if (!RECONCILE_SECRET || !safeEqual(presentedSecret, RECONCILE_SECRET)) {
    // An unauthorized caller (wrong/missing secret). An auth event — the
    // legitimate cron always presents the matching secret.
    await recordAlert(supabase, {
      severity: "critical",
      category: "auth",
      title: "reconcile-payments received an unauthorized call",
      details: { hint: "caller supplied an invalid x-reconcile-secret" },
    })
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  try {
    let totalActions = 0

    // --- Step 1: Check stale pending payments against Razorpay ---
    // Give up on payments pending >2h — log for manual review.
    const { data: gaveUpPayments } = await supabase
      .from("payments")
      .select("id")
      .eq("status", "pending")
      .not("razorpay_order_id", "is", null)
      .is("deleted_at", null)
      .lt("created_at", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())

    for (const pay of gaveUpPayments || []) {
      const { data: alreadyLogged } = await supabase
        .from("payment_audit_log")
        .select("id")
        .eq("payment_id", pay.id)
        .eq("action", "payment_reconcile_gave_up")
        .maybeSingle()
      if (alreadyLogged) continue

      const { data: gaveUp } = await supabase
        .from("payments")
        .select("registration_id, coupon_id")
        .eq("id", pay.id)
        .single()
      await supabase.from("payments").update({ status: "failed" }).eq("id", pay.id)
      if (gaveUp?.registration_id) {
        await supabase.from("registrations").update({
          status: "cancelled",
          updated_at: new Date().toISOString(),
        }).eq("id", gaveUp.registration_id)
      }
      if (gaveUp?.coupon_id) {
        try {
          await supabase.rpc("release_coupon", { p_coupon_id: gaveUp.coupon_id })
        } catch {
          // Best-effort coupon release on a give-up.
        }
      }
      await supabase.from("payment_audit_log").insert({
        action: "payment_reconcile_gave_up",
        payment_id: pay.id,
        details: { note: "Pending >2h — registration cancelled; manual review required" },
      })
      await recordAlert(supabase, {
        severity: "warning",
        category: "payment",
        title: "Reconcile gave up on stale pending payment",
        details: { payment_id: pay.id },
      })
      totalActions++
    }

    // Check payments 2 min–2h old against Razorpay. 2 minutes is the floor so
    // a payment.captured webhook that never delivered is caught long before
    // the old 10-minute window — the user sees a confirmed booking, not a
    // stuck "Confirming…" spinner.
    const { data: stalePayments, error: queryErr } = await supabase
      .from("payments")
      .select("id, razorpay_order_id, registration_id, coupon_id, created_at")
      .eq("status", "pending")
      .not("razorpay_order_id", "is", null)
      .is("deleted_at", null)
      .gt("created_at", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
      .lt("created_at", new Date(Date.now() - 2 * 60 * 1000).toISOString())

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
                await recordAlert(supabase, {
                  severity: "warning",
                  category: "payment",
                  title: "Auto-refund failed for payment",
                  details: { payment_id: pay.id, error: refundErr instanceof Error ? refundErr.message : String(refundErr) },
                })
              }
            } else {
              // Reconcile confirmed it from Razorpay — this payment.captured
              // webhook never reached us. That is exactly the failure we want
              // to SEE (the Oct 12 outage class), not silently repair.
              await recordAlert(supabase, {
                severity: "warning",
                category: "payment",
                title: "Payment confirmed by reconcile — webhook delivery missed",
                details: {
                  payment_id: pay.id,
                  razorpay_order_id: pay.razorpay_order_id,
                  note: "payment.captured webhook was not delivered; order resolved via Razorpay query. Check the Razorpay webhook configuration.",
                },
              })
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
        await recordAlert(supabase, {
          severity: "warning",
          category: "payout",
          title: "refund_wallet failed for payout",
          details: { payout_id: payout.id, error: refundErr.message },
        })
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
        await recordAlert(supabase, {
          severity: "warning",
          category: "payout",
          title: "refund_wallet failed for payout",
          details: { payout_id: payout.id, error: refundErr.message },
        })
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
    await recordAlert(supabase, {
      severity: "critical",
      category: "payment",
      title: "reconcile-payments unhandled error",
      details: { error: err instanceof Error ? err.message : String(err) },
    })
    return new Response(JSON.stringify({ error: "Reconciliation failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})