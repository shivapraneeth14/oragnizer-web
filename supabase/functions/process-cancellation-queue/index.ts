import { optionalEnv, requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { attemptRefund } from "../_shared/refunds.ts"
import {
  razorpayGet,
  RazorpayClientError,
  RazorpayUncertainOutcomeError,
} from "../_shared/razorpay.ts"
import { calculateTaskBackoff, type RefundTask } from "../_shared/cancellation.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const RECONCILE_SECRET = optionalEnv("RECONCILE_SECRET")

const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-worker-secret",
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  try {
    // 1. Verify caller secret
    const incomingWorkerSecret = req.headers.get("x-worker-secret")
    const authHeader = req.headers.get("Authorization")
    const isServiceAuth = authHeader === `Bearer ${supabaseServiceKey}`
    const isSecretAuth = Boolean(RECONCILE_SECRET && incomingWorkerSecret === RECONCILE_SECRET)

    if (!isServiceAuth && !isSecretAuth) {
      return new Response(JSON.stringify({ error: "Unauthorized worker request" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const workerId = `worker_${crypto.randomUUID().slice(0, 8)}`
    const startTime = Date.now()
    const MAX_EXECUTION_TIME_MS = 40_000 // 40 seconds max per invocation

    let totalProcessed = 0
    let totalCompleted = 0
    let totalFailed = 0
    let totalUncertain = 0

    const touchedJobIds = new Set<string>()

    // Bounded batch loop
    while (Date.now() - startTime < MAX_EXECUTION_TIME_MS) {
      // Claim up to 20 tasks
      const { data: tasks, error: claimErr } = await supabase.rpc("claim_refund_tasks", {
        p_batch_size: 20,
        p_worker_id: workerId,
        p_lease_seconds: 120,
      })

      if (claimErr) {
        console.error("Error claiming refund tasks:", claimErr)
        break
      }

      const batch = (tasks || []) as RefundTask[]
      if (batch.length === 0) {
        // No claimable tasks in queue
        break
      }

      for (const task of batch) {
        touchedJobIds.add(task.job_id)

        // Time budget check
        if (Date.now() - startTime >= MAX_EXECUTION_TIME_MS) {
          // Time expired; yield task back by setting lease_expires_at to now
          await supabase.from("refund_task_queue").update({
            lease_expires_at: new Date().toISOString(),
          }).eq("id", task.id)
          break
        }

        // Heartbeat renewal: extend lease by 60s right before provider call
        await supabase.from("refund_task_queue").update({
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        }).eq("id", task.id)

        totalProcessed++

        try {
          if (task.task_type === "cancel_only") {
            await supabase.rpc("cancel_registration_and_decrement", {
              p_registration_id: task.registration_id,
              p_deleted_at: new Date().toISOString(),
            })

            await supabase.from("refund_task_queue").update({
              status: "completed",
              error_message: null,
              updated_at: new Date().toISOString(),
            }).eq("id", task.id)

            totalCompleted++
            continue
          }

          // task_type === 'refund'
          if (!task.payment_id) {
            throw new Error("Refund task is missing payment_id")
          }

          const { data: payment, error: pErr } = await supabase
            .from("payments")
            .select("id, amount, razorpay_payment_id, razorpay_order_id, registration_id, status, platform_fee, organizer_share, refund_claim_state, refund_status")
            .eq("id", task.payment_id)
            .single()

          if (pErr || !payment) {
            throw new Error(`Payment ${task.payment_id} not found`)
          }

          // If payment was already refunded
          if (payment.status === "refunded" || payment.refund_claim_state === "issued") {
            await supabase.rpc("cancel_registration_and_decrement", {
              p_registration_id: task.registration_id,
              p_deleted_at: new Date().toISOString(),
            })

            await supabase.from("refund_task_queue").update({
              status: "completed",
              razorpay_refund_id: payment.razorpay_refund_id,
              error_message: "Payment already refunded",
              updated_at: new Date().toISOString(),
            }).eq("id", task.id)

            totalCompleted++
            continue
          }

          // If payment is pending: check order capture status at Razorpay
          if (payment.status === "pending" && payment.razorpay_order_id) {
            const order = await razorpayGet(`orders/${payment.razorpay_order_id}`).catch(() => null)
            if (order && order.status === "paid" && (order.amount_paid || 0) > 0) {
              const payBody = await razorpayGet(`orders/${payment.razorpay_order_id}/payments`).catch(() => null)
              const captured = payBody?.items?.find((p: any) => p.status === "captured")
              if (captured) {
                await supabase.from("payments").update({ razorpay_payment_id: captured.id }).eq("id", payment.id)
                await supabase.rpc("confirm_payment", { p_payment_id: payment.id })
                payment.status = "success"
                payment.razorpay_payment_id = captured.id
              }
            } else {
              // Unpaid pending order: close out
              await supabase.from("payments").update({
                status: "failed",
                failure_reason: "event_cancelled",
              }).eq("id", payment.id)

              await supabase.rpc("cancel_registration_and_decrement", {
                p_registration_id: task.registration_id,
                p_deleted_at: new Date().toISOString(),
              })

              await supabase.from("refund_task_queue").update({
                status: "completed",
                error_message: "Unpaid pending order closed on event cancellation",
                updated_at: new Date().toISOString(),
              }).eq("id", task.id)

              totalCompleted++
              continue
            }
          }

          // Issue refund via attemptRefund
          const outcome = await attemptRefund(supabase, payment, task.amount, "event_cancellation")

          if (outcome.status === "conflict") {
            // Concurrent claim lock active: backoff 30s
            await supabase.from("refund_task_queue").update({
              status: "pending",
              next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
              error_message: "Concurrent claim conflict; backoff scheduled",
              updated_at: new Date().toISOString(),
            }).eq("id", task.id)
            continue
          }

          // Successfully issued or recovered
          await supabase.rpc("cancel_registration_and_decrement", {
            p_registration_id: task.registration_id,
            p_deleted_at: new Date().toISOString(),
          })

          const platformFee = Math.max(Number(payment.platform_fee ?? 0), 0)
          if (platformFee > 0) {
            await supabase.from("payment_audit_log").insert({
              action: "commission_reversed",
              payment_id: payment.id,
              details: {
                commission_amount: platformFee,
                reason: "event_cancellation",
                job_id: task.job_id,
                task_id: task.id,
              },
            })
          }

          await supabase.from("refund_task_queue").update({
            status: "completed",
            razorpay_refund_id: outcome.refund_id,
            error_message: null,
            updated_at: new Date().toISOString(),
          }).eq("id", task.id)

          totalCompleted++

        } catch (err: any) {
          if (err instanceof RazorpayUncertainOutcomeError) {
            // UNCERTAINTY PROTOCOL:
            // Outcome is uncertain. Never blindly retry. Place task in 'uncertain' with 2m quiet period.
            totalUncertain++
            const isExhausted = task.attempt_count >= task.max_attempts
            const newStatus = isExhausted ? "manual_review" : "uncertain"

            await supabase.from("refund_task_queue").update({
              status: newStatus,
              next_attempt_at: new Date(Date.now() + 120_000).toISOString(),
              error_message: `Uncertain outcome: ${err.message}`,
              error_details: { code: err.statusCode, isExhausted },
              updated_at: new Date().toISOString(),
            }).eq("id", task.id)

            if (isExhausted) {
              await supabase.from("payment_audit_log").insert({
                action: "refund_task_manual_review_required",
                payment_id: task.payment_id,
                details: {
                  task_id: task.id,
                  job_id: task.job_id,
                  reason: "Uncertainty attempts exhausted",
                  error: err.message,
                },
              })
            }

          } else if (err instanceof RazorpayClientError) {
            // Permanent client 4xx rejection: do NOT retry
            totalFailed++
            await supabase.from("refund_task_queue").update({
              status: "manual_review",
              error_message: `Provider rejected: ${err.message}`,
              error_details: { code: err.statusCode, body: err.errorData },
              updated_at: new Date().toISOString(),
            }).eq("id", task.id)

            await supabase.from("payment_audit_log").insert({
              action: "refund_task_manual_review_required",
              payment_id: task.payment_id,
              details: {
                task_id: task.id,
                job_id: task.job_id,
                reason: "Provider client rejection",
                error: err.message,
              },
            })

          } else {
            // Generic transient error: schedule retry with exponential backoff
            totalFailed++
            const isExhausted = task.attempt_count >= task.max_attempts
            const newStatus = isExhausted ? "manual_review" : "failed"
            const backoffMs = calculateTaskBackoff(task.attempt_count)

            await supabase.from("refund_task_queue").update({
              status: newStatus,
              next_attempt_at: new Date(Date.now() + backoffMs).toISOString(),
              error_message: `Transient failure: ${err.message}`,
              updated_at: new Date().toISOString(),
            }).eq("id", task.id)

            if (isExhausted) {
              await supabase.from("payment_audit_log").insert({
                action: "refund_task_manual_review_required",
                payment_id: task.payment_id,
                details: {
                  task_id: task.id,
                  job_id: task.job_id,
                  reason: "Max retries exhausted",
                  error: err.message,
                },
              })
            }
          }
        }
      }
    }

    // Advance progress for all touched jobs
    for (const jobId of touchedJobIds) {
      await supabase.rpc("update_cancellation_job_progress", { p_job_id: jobId })
    }

    return new Response(JSON.stringify({
      success: true,
      worker_id: workerId,
      processed: totalProcessed,
      completed: totalCompleted,
      failed: totalFailed,
      uncertain: totalUncertain,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })

  } catch (err: any) {
    console.error("Cancellation queue worker error:", err)
    return new Response(JSON.stringify({ error: err.message || "Worker failure" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})

