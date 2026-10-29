import { optionalEnv, requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { recordAlert } from "../_shared/alerts.ts"
import { safeEqual } from "../_shared/crypto.ts"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { attemptRefund, refundRetryPlan, RefundNotPossibleError } from "../_shared/refunds.ts"
import {
  flagRefundExhausted,
  isProviderRefundDead,
  nextRefundAttempt,
  REFUND_ATTEMPT_CAP,
  refundPendingTooLong,
  shouldFlagExhausted,
} from "../_shared/refund-retry.ts"
import {
  resolvePendingPayment,
  type PendingDeps,
} from "../_shared/reconcile-pending.ts"

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

// Everything the pending-payment resolver needs from the real world. Kept as
// an explicit dependency object so the decision/ordering can be unit-tested
// without booting Deno.serve or reaching a live database.
const pendingDeps: PendingDeps = {
  getOrder: async (orderId) => await razorpayGet(`orders/${orderId}`),
  listOrderPayments: async (orderId) => {
    const body = await razorpayGet(`orders/${orderId}/payments`)
    return body?.items ?? []
  },
  setCapturedPaymentId: async (paymentId, capturedPaymentId) => {
    await supabase
      .from("payments")
      .update({ razorpay_payment_id: capturedPaymentId })
      .eq("id", paymentId)
  },
  confirmPayment: async (paymentId) => {
    const { data, error } = await supabase.rpc("confirm_payment", { p_payment_id: paymentId })
    if (error) return { error: error.message }
    return data as { action?: string; error?: string; skipped?: boolean } | null
  },
  // Guarded on the row still being 'pending': a payment confirmed by a webhook
  // between our read and this write must win, never be clobbered.
  markExpired: async (paymentId) => {
    const { data, error } = await supabase
      .from("payments")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", paymentId)
      .eq("status", "pending")
      .select("id")
    if (error) {
      console.error(`Failed to expire payment ${paymentId}:`, error)
      return false
    }
    return Boolean(data?.length)
  },
  cancelRegistration: async (registrationId) => {
    await supabase
      .from("registrations")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", registrationId)
      .eq("status", "pending")
  },
  releaseCoupon: async (couponId) => {
    try {
      await supabase.rpc("release_coupon", { p_coupon_id: couponId })
    } catch {
      // Best-effort coupon release on a give-up.
    }
  },
  audit: async (action, paymentId, details) => {
    await supabase.from("payment_audit_log").insert({
      action,
      payment_id: paymentId,
      details,
    })
  },
}

// Attempts a Razorpay refund for a payment that must go back to the customer.
// Claim-guarded by _shared/refunds.attemptRefund: concurrent callers (cancel
// flows, this job) serialize on the payment and exactly one issues the refund;
// the wallet clawback runs once inside complete_payment_refund.
async function processRefund(paymentId: string, amount: number, reason: string): Promise<boolean> {
  const { data: payment } = await supabase
    .from("payments")
    .select("id, razorpay_payment_id, refund_attempt_count, registration_id, amount, platform_fee, organizer_share")
    .eq("id", paymentId)
    .single()

  if (!payment) return false

  // attemptRefund throws when the payment is not refundable or the provider
  // refused after a provider re-check; conflict/already_refunded are clean
  // no-ops so concurrent refunders never double-refund.
  const outcome = await attemptRefund(supabase, payment, amount, reason)
  if (outcome.status === "conflict" || outcome.status === "already_refunded") return false

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
  return true
}

// Records the terminal "out of retries" state exactly once per payment. The
// audit row is the dedupe gate; the alert is per-payment so one customer's
// failure does not hide another's (recordAlert used to dedupe by title only).
async function flagExhausted(
  paymentId: string,
  attempts: number,
  note?: string,
): Promise<boolean> {
  return await flagRefundExhausted(
    { paymentId, attempts, note },
    {
      hasAudit: async (id) => {
        const { data } = await supabase
          .from("payment_audit_log")
          .select("id")
          .eq("payment_id", id)
          .eq("action", "refund_retry_exhausted")
          .maybeSingle()
        return Boolean(data)
      },
      insertAudit: async (id, attempts, note) => {
        const { error } = await supabase.from("payment_audit_log").insert({
          action: "refund_retry_exhausted",
          payment_id: id,
          details: { note, attempts },
        })
        if (error) {
          console.error(`Failed to record refund_retry_exhausted for ${id}:`, error)
          return false
        }
        return true
      },
      alert: async (id, attempts, note) => {
        await recordAlert(supabase, {
          severity: "critical",
          category: "payment",
          title: "Refund retries exhausted for payment",
          dedupeKey: `refund_retry_exhausted:${id}`,
          details: { payment_id: id, attempts, note },
        })
      },
    },
  )
}

// Rows already at the cap are excluded by the retry query below, so without
// this sweep a row pushed to 5 by the provider-sync branch or the webhook would
// sit there forever with no refund_retry_exhausted record and no alert.
async function flagExhaustedRefunds(): Promise<number> {
  const { data: rows, error } = await supabase
    .from("payments")
    .select("id, refund_status, razorpay_refund_id, refund_attempt_count, updated_at")
    .in("status", ["refunded", "failed", "success"])
    .or("refund_status.in.(requested,pending,failed,queued),and(refund_status.is.null,refund_reason.not.is.null)")
    .gte("refund_attempt_count", REFUND_ATTEMPT_CAP)

  if (error) {
    console.error("Refund exhaustion sweep failed:", error)
    return 0
  }

  let flagged = 0
  for (const row of rows ?? []) {
    if (!shouldFlagExhausted(row)) continue
    if (await flagExhausted(row.id, Number(row.refund_attempt_count ?? REFUND_ATTEMPT_CAP))) {
      flagged++
    }
  }
  return flagged
}

// Refunds owed to customers whose payment reached us but could never be
// confirmed (e.g. event cancelled after capture). Capped retries — the
// webhook keeps the real refund state in sync; 5 failed attempts flag the
// payment for manual follow-up via the refund_retry_exhausted audit action.
async function retryPendingRefunds(): Promise<number> {
  // Surface rows that already reached the cap before this cycle.
  let handled = await flagExhaustedRefunds()

  const { data: dueRefunds, error: dueErr } = await supabase
    .from("payments")
    .select("id, refund_status, refund_attempt_count, razorpay_refund_id, amount, refunded_amount, refund_amount_due, refund_reason, updated_at, status")
    // 'refunded': cancellation refund failed. 'failed': money captured but
    // never confirmed (event cancelled) - owed back to the customer.
    // 'success': money captured AND refund attempt already failed - the
    // retry must NOT skip these, or the customer is stranded forever.
    .in("status", ["refunded", "failed", "success"])
    .or("refund_status.in.(requested,pending,failed,queued),and(refund_status.is.null,refund_reason.not.is.null)")
    .lt("refund_attempt_count", REFUND_ATTEMPT_CAP)
    // Recooldown: skip rows being re-ordered by create-payment (it bumps
    // updated_at) so we never refund a freshly-captured payment twice.
    .lt("updated_at", new Date(Date.now() - 15 * 60 * 1000).toISOString())

  if (dueErr) throw dueErr

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
        if (isProviderRefundDead(refund?.status)) {
          const attempts = nextRefundAttempt(pay.refund_attempt_count)
          await supabase.from("payments").update({
            refund_status: "failed",
            refund_attempt_count: attempts,
          }).eq("id", pay.id)
          // This path can reach the cap too; record it here, not only in the
          // catch block below.
          if (attempts >= REFUND_ATTEMPT_CAP) {
            await flagExhausted(pay.id, attempts)
          }
          handled++
          continue
        }
        // Still in flight at the provider (or the lookup failed). A refund that
        // never settles must not disappear quietly.
        if (refundPendingTooLong(pay.updated_at)) {
          await recordAlert(supabase, {
            severity: "warning",
            category: "payment",
            title: "Refund still pending at Razorpay after 24h",
            dedupeKey: `refund_pending_24h:${pay.id}`,
            details: {
              payment_id: pay.id,
              razorpay_refund_id: pay.razorpay_refund_id,
              refund_status: pay.refund_status,
            },
          })
        }
        continue
      }

      // No provider refund yet, or the last one failed: issue/retry one.
      // POLICY INTEGRITY: refundRetryPlan uses the persisted owed amount and
      // cancellation type — never re-derives. A failed customer-cancellation
      // refund retries exactly the owed ticket (platform fee excluded); an
      // organizer-cancellation refund retries the full amount.
      const { amount: retryAmount, reason: retryReason } = refundRetryPlan(pay)
      if (await processRefund(pay.id, retryAmount, retryReason)) handled++
    } catch (err) {
      console.error(`Refund retry failed for ${pay.id}:`, err)

      if (err instanceof RefundNotPossibleError) {
        // A permanent precondition: retrying will never succeed. Flag it once
        // instead of alerting every cycle forever.
        await flagExhausted(
          pay.id,
          Number(pay.refund_attempt_count ?? 0),
          `Unable to start a refund: ${err.message}`,
        )
        continue
      }

      await recordAlert(supabase, {
        severity: "warning",
        category: "payment",
        title: "Refund retry failed for payment",
        dedupeKey: `refund_retry_failed:${pay.id}`,
        details: { payment_id: pay.id, error: err instanceof Error ? err.message : String(err) },
      })
      const { data: after } = await supabase
        .from("payments")
        .select("refund_attempt_count")
        .eq("id", pay.id)
        .single()
      const attempts = after?.refund_attempt_count ?? Number(pay.refund_attempt_count ?? 0)
      if (attempts >= REFUND_ATTEMPT_CAP) {
        await flagExhausted(pay.id, attempts)
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

    // --- Step 1: Resolve pending payments (>2 minutes old) against Razorpay ---
    // G-01: ask Razorpay first, always. A payment is given up on only when the
    // provider proves no money was captured — never merely because it is old.
    // Captured payments are confirmed (or refunded when the event is gone),
    // even when they are hours old. The 2-minute floor catches a lost
    // payment.captured webhook long before the user gives up on the spinner.
    const { data: stalePayments, error: queryErr } = await supabase
      .from("payments")
      .select("id, razorpay_order_id, registration_id, coupon_id, created_at")
      .eq("status", "pending")
      .not("razorpay_order_id", "is", null)
      .is("deleted_at", null)
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
        const outcome = await resolvePendingPayment(pay, pendingDeps)

        switch (outcome.action) {
          case "confirmed":
            // Reconcile confirmed it from Razorpay — this payment.captured
            // webhook never reached us. That is exactly the failure we want
            // to SEE (the Oct 12 outage class), not silently repair.
            await recordAlert(supabase, {
              severity: "warning",
              category: "payment",
              title: "Payment confirmed by reconcile — webhook delivery missed",
              dedupeKey: `payment_confirmed_missed_webhook:${pay.id}`,
              details: {
                payment_id: pay.id,
                razorpay_order_id: pay.razorpay_order_id,
                note: "payment.captured webhook was not delivered; order resolved via Razorpay query. Check the Razorpay webhook configuration.",
              },
            })
            console.log(`Reconciled payment ${pay.id} — captured via Razorpay, confirmed`)
            totalActions++
            break

          case "refund_required":
            // Money was captured but the event was cancelled (or capacity
            // vanished). Refund now — the customer keeps nothing.
            try {
              if (await processRefund(pay.id, outcome.amount, "reconcile_event_cancelled")) {
                totalActions++
              }
            } catch (refundErr) {
              console.error(`Auto-refund failed for ${pay.id}:`, refundErr)
              await recordAlert(supabase, {
                severity: "warning",
                category: "payment",
                title: "Auto-refund failed for payment",
                dedupeKey: `auto_refund_failed:${pay.id}`,
                details: {
                  payment_id: pay.id,
                  error: refundErr instanceof Error ? refundErr.message : String(refundErr),
                },
              })
            }
            break

          case "expired":
            await recordAlert(supabase, {
              severity: "warning",
              category: "payment",
              title: "Reconcile gave up on stale pending payment",
              dedupeKey: `reconcile_gave_up:${pay.id}`,
              details: {
                payment_id: pay.id,
                razorpay_order_id: pay.razorpay_order_id,
                note: "Pending >2h and Razorpay confirms no payment was captured — registration cancelled; manual review required",
              },
            })
            totalActions++
            break

          case "manual":
            await recordAlert(supabase, {
              severity: "warning",
              category: "payment",
              title: "Reconcile needs manual review for a pending payment",
              dedupeKey: `reconcile_manual:${pay.id}`,
              details: {
                payment_id: pay.id,
                razorpay_order_id: pay.razorpay_order_id,
                reason: outcome.reason,
                error: outcome.error,
              },
            })
            break

          case "already_confirmed":
          case "wait":
            if (outcome.action === "wait" && outcome.reason && outcome.reason !== "race_lost") {
              console.error(`Reconcile could not resolve payment ${pay.id}: ${outcome.reason}`)
            }
            break
        }
      } catch (err) {
        console.error(`Reconcile failed for payment ${pay.id} — skipping, will retry next cycle:`, err)
        await recordAlert(supabase, {
          severity: "warning",
          category: "payment",
          title: "Reconcile failed to resolve a pending payment",
          dedupeKey: `reconcile_error:${pay.id}`,
          details: {
            payment_id: pay.id,
            error: err instanceof Error ? err.message : String(err),
          },
        })
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