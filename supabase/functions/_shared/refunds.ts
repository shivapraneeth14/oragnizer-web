import { requiredEnv } from "./env.ts"

const RAZORPAY_KEY_ID = requiredEnv("RAZORPAY_KEY_ID")
const RAZORPAY_KEY_SECRET = requiredEnv("RAZORPAY_KEY_SECRET")

// Razorpay refund entity status -> our payments.refund_status domain.
// 'queued' is preserved (a provider-accepted refud awaiting processing) so the
// reconcile job's queued-sync path treats it as "accepted — sync, never
// re-issue"; claims also treat pending/queued as already refunded.
export function mapRefundStatus(status: string | undefined): string {
  switch (status) {
    case "processed":
      return "processed"
    case "pending":
      return "pending"
    case "queued":
    case "created":
      return "queued"
    case "initiated":
      return "pending"
    case "failed":
    case "reversed":
    case "cancelled":
      return "failed"
    default:
      return "pending"
  }
}

export async function razorpayPost(path: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error?.description || `Razorpay API error (${res.status})`)
  return data
}

export async function razorpayGet(path: string): Promise<any> {
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { description: `HTTP ${res.status}` } }))
    throw new Error(err.error?.description || `Razorpay error (${res.status})`)
  }
  return res.json()
}

interface ProviderRefund {
  id: string
  status?: string
  amount?: number
}

// A refund in these states never moved money to the customer, so it must not
// be mistaken for an already-issued refund; retrying is the correct action.
const DEAD_REFUND_STATUSES = new Set(["failed", "cancelled", "reversed"])

async function fetchProviderRefunds(razorpayPaymentId: string): Promise<ProviderRefund[]> {
  const body = await razorpayGet(`payments/${razorpayPaymentId}/refunds`)
  return body?.items ?? []
}

function pickLiveRefund(items: ProviderRefund[]): ProviderRefund | null {
  return items.find((r) => !DEAD_REFUND_STATUSES.has(String(r.status ?? ""))) ?? null
}

// Best-effort provider lookup used after a failed refund POST, when the
// original error matters more than the lookup error. Only a refund that may
// have moved money is returned.
export async function firstExistingRefund(
  _supabase: any,
  razorpayPaymentId: string,
): Promise<ProviderRefund | null> {
  try {
    return pickLiveRefund(await fetchProviderRefunds(razorpayPaymentId))
  } catch {
    return null
  }
}

export interface RefundOutcome {
  status: "issued" | "already_refunded" | "conflict"
  refund_id?: string | null
  refund_status?: string | null
  amount?: number
  attempt?: number
  // True when a retry found a refund the provider had already accepted and
  // recorded it instead of issuing a second one.
  recovered?: boolean
}

// --- Refund-amount policy -----------------------------------------------------
// Business rule, applied identically by every call site, retry and reconcile
// pass:
//   organizer-cancelled  -> refund the FULL amount (platform fee included):
//     event_cancellation, organizer_issue_refund, capacity_full,
//     event_cancelled, registration_cancelled (auto full refund on a capture
//     that landed on a cancelled booking).
//   customer-cancelled   -> refund amount MINUS the persisted platform fee:
//     registration_cancellation (self-cancel via cancel-registration).
// The cancellation type is persisted on payments.refund_reason at the first
// claim and never overwritten; retries always re-use it (and the persisted
// refund_amount_due) instead of re-deriving.
export type RefundPolicy = "customer" | "organizer"

export function refundPolicyForReason(reason: string | null | undefined): RefundPolicy {
  return reason === "registration_cancellation" ? "customer" : "organizer"
}

// The exact customer-owed amount under a policy, from the stored breakdown —
// never a recomputed percentage.
export function refundAmountForPolicy(
  policy: RefundPolicy,
  payment: { amount: number | null | undefined; platform_fee?: number | null },
): number {
  const amount = Math.max(Number(payment.amount ?? 0), 0)
  if (policy === "customer") return customerOwedAmount(payment)
  return amount
}

export function customerOwedAmount(payment: {
  amount: number | null | undefined
  platform_fee?: number | null
}): number {
  const fee = Math.max(Number(payment.platform_fee ?? 0), 0)
  return Math.max(Number(payment.amount ?? 0) - fee, 0)
}

// How a failed/in-flight refund must be RETRIED: the persisted owed amount
// and the persisted cancellation type — never re-derived. A failed
// customer-cancellation refund retries exactly refund_amount_due (ticket
// only, fee kept); an organizer-cancellation refund retries the full amount.
// The old `refunded_amount ?? amount` fallback retried the FULL amount for
// failed self-cancels — handing back the fee the platform is entitled to
// keep. Legacy rows without persisted due/reason keep the historical
// fallback (documented residual for pre-migration failures only).
export function refundRetryPlan(row: {
  amount?: number | null
  refunded_amount?: number | null
  refund_amount_due?: number | null
  refund_reason?: string | null
}): { amount: number; reason: string } {
  return {
    amount: Number(row.refund_amount_due ?? row.refunded_amount ?? row.amount ?? 0),
    reason: row.refund_reason ?? "reconcile_refund_retry",
  }
}

// A refund that can never succeed for this row (no captured payment id, or the
// claim machine rejects its current state). Callers should stop retrying and
// flag it for manual follow-up instead of looping forever.
export class RefundNotPossibleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RefundNotPossibleError"
  }
}

// Exactly-once refund issuance. All refund entry points (cancel-event,
// cancel-registration, issue-refund, reconcile retry) must go through this:
//   1. claim_payment_refund     -> atomic lock; exactly one winner per payment
//                                  (also persists refund_reason + the owed
//                                  refund_amount_due exactly once)
//   2. Retry pre-check          -> on a stale claim or any retry, ask Razorpay
//                                  whether a prior attempt already sent money
//   3. Razorpay refund          -> the single provider call
//   4. complete_payment_refund  -> persists 'issued', records wallet clawback
// If the pre-check itself fails, the claim is released and the error is
// surfaced: never send money unless we proved none was sent. Provider failures
// after the POST are re-checked the same way before giving up.
export async function attemptRefund(
  supabase: any,
  payment: { id: string; razorpay_payment_id?: string | null },
  amount: number,
  walletReason: string,
): Promise<RefundOutcome> {
  if (!payment.razorpay_payment_id) {
    throw new RefundNotPossibleError(`Payment ${payment.id} has no razorpay_payment_id`)
  }

  const { data: claim, error: claimErr } = await supabase.rpc("claim_payment_refund", {
    p_payment_id: payment.id,
    p_reason: walletReason,
    p_amount: amount,
  })
  if (claimErr) throw claimErr

  if (claim?.error) throw new RefundNotPossibleError(claim.error)
  if (claim?.already_refunded) {
    return {
      status: "already_refunded",
      refund_id: claim.razorpay_refund_id,
      refund_status: claim.refund_status ?? null,
    }
  }
  if (claim?.conflict) {
    // Another flow holds a fresh claim on this payment — back off, never
    // double-refund. The holder settles it (or a stale reclaim recovers it).
    return { status: "conflict" }
  }

  const completeIssued = async (refund: any, issuedAmount: number) => {
    const { data, error } = await supabase.rpc("complete_payment_refund", {
      p_payment_id: payment.id,
      p_success: true,
      p_refund_id: refund.id,
      p_status: mapRefundStatus(refund.status),
      p_amount: issuedAmount,
      p_wallet_reason: walletReason,
    })
    if (error) throw error
    // The RPC reports "no live claim"/"payment not found" in a JSONB {error}
    // body (not a transport error); surface it so we never treat an unsettled
    // claim as issued.
    if (data?.error) throw new Error(data.error)
    return refund
  }

  const releaseClaim = async () => {
    await supabase.rpc("complete_payment_refund", {
      p_payment_id: payment.id,
      p_success: false,
    }).catch(() => {})
  }

  // The claim is held now, so no other flow can issue a refund while we ask
  // the provider. A stale claim means the previous attempt may have reached
  // Razorpay before crashing; attempt > 1 also covers a claim released as
  // failed after a lost provider response.
  const isRetry = claim?.stale_reclaimed === true || Number(claim?.attempt ?? 1) > 1
  if (isRetry) {
    let existing: ProviderRefund | null
    try {
      existing = pickLiveRefund(await fetchProviderRefunds(payment.razorpay_payment_id))
    } catch (err) {
      // Fail closed: we cannot prove no refund was sent, so send nothing.
      await releaseClaim()
      throw err
    }

    if (existing) {
      // The provider already moved the money. Record its truth and return
      // without issuing a second refund.
      await completeIssued(existing, existing.amount ?? amount)
      console.warn(
        `[refund] recovered existing refund ${existing.id} for payment ${payment.id} (attempt ${claim.attempt})`,
      )
      return {
        status: "issued",
        refund_id: existing.id,
        refund_status: mapRefundStatus(existing.status),
        amount: existing.amount ?? amount,
        attempt: claim.attempt,
        recovered: true,
      }
    }
  }

  let refund: any
  try {
    refund = await razorpayPost(`payments/${payment.razorpay_payment_id}/refund`, {
      amount,
      receipt: `ref_${payment.id}_${claim.attempt}`,
    })
    await completeIssued(refund, amount)
    return { status: "issued", refund_id: refund.id, refund_status: mapRefundStatus(refund.status), amount, attempt: claim.attempt }
  } catch (err) {
    // Crash between claim and provider call that was recovered as stale, or a
    // provider failure: the refund may still exist at Razorpay. Ask first.
    const existing = await firstExistingRefund(supabase, payment.razorpay_payment_id)
    if (existing) {
      await completeIssued(existing, existing.amount ?? amount)
      return { status: "issued", refund_id: existing.id, refund_status: mapRefundStatus(existing.status), amount: existing.amount ?? amount, attempt: claim.attempt }
    }
    // Release the claim as 'failed' so a later retry may claim again.
    await releaseClaim()
    throw err
  }
}