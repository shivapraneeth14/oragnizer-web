// Refund retry bookkeeping shared by reconcile-payments.
//
// G-01: retries are capped, but the cap must be recorded on every path that can
// consume an attempt — this job, the provider-status sync branch, and the
// refund webhook all increment refund_attempt_count. Before this helper only
// one of those paths wrote the refund_retry_exhausted audit row, so a row could
// silently fall out of the retry queue with nobody told.

export const REFUND_ATTEMPT_CAP = 5
export const REFUND_PENDING_ALERT_AFTER_MS = 24 * 60 * 60 * 1000

// Provider statuses that never moved money to the customer.
const DEAD_PROVIDER_REFUND_STATUSES = new Set(["failed", "cancelled", "reversed"])

export function nextRefundAttempt(count: number | null | undefined): number {
  return Number(count ?? 0) + 1
}

export function isProviderRefundDead(status: string | null | undefined): boolean {
  return DEAD_PROVIDER_REFUND_STATUSES.has(String(status ?? ""))
}

export interface RefundRetryRow {
  id: string
  refund_status?: string | null
  razorpay_refund_id?: string | null
  refund_attempt_count?: number | null
  updated_at?: string | null
}

// A refund the provider has accepted is in flight, not exhausted — even at the
// cap. Anything else at the cap (failed, or no provider id) is stuck and needs
// a human.
export function shouldFlagExhausted(row: RefundRetryRow): boolean {
  const attempts = Number(row.refund_attempt_count ?? 0)
  if (attempts < REFUND_ATTEMPT_CAP) return false
  if (row.refund_status === "failed") return true
  return !row.razorpay_refund_id
}

export function refundPendingTooLong(
  updatedAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!updatedAt) return false
  const time = new Date(updatedAt).getTime()
  return Number.isFinite(time) && now - time >= REFUND_PENDING_ALERT_AFTER_MS
}

export const EXHAUSTED_NOTE = "Refund retries exhausted — manual follow-up required"

export interface ExhaustionDeps {
  hasAudit(paymentId: string): Promise<boolean>
  insertAudit(paymentId: string, attempts: number, note: string): Promise<boolean>
  alert(paymentId: string, attempts: number, note: string): Promise<void>
}

// Idempotent: the audit row is the dedupe gate, so the alert is recorded once
// per payment even if several paths reach the cap in the same cycle.
export async function flagRefundExhausted(
  input: { paymentId: string; attempts: number; note?: string },
  deps: ExhaustionDeps,
): Promise<boolean> {
  const note = input.note ?? EXHAUSTED_NOTE
  if (await deps.hasAudit(input.paymentId)) return false
  if (!(await deps.insertAudit(input.paymentId, input.attempts, note))) return false
  await deps.alert(input.paymentId, input.attempts, note)
  return true
}
