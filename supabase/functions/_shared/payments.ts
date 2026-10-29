import type { SupabaseClient } from "jsr:@supabase/supabase-js@2"

export interface PaymentRowSummary {
  id?: string
  status: string | null
  refund_status?: string | null
  refund_claim_state?: string | null
  razorpay_refund_id?: string | null
  refunded_amount?: number | null
  razorpay_payment_id?: string | null
  refund_reason?: string | null
  refund_amount_due?: number | null
  refund_attempt_count?: number | null
}

// A payment row that is paid, or has a refund in flight at the provider, must
// NEVER be demoted to `pending`: re-quoting it would resurrect a cancelled
// booking and hand the user a Pay screen for money that already moved.
// Returns null when re-quote / reuse is allowed.
// A recorded refund debt means money must go back to the customer; re-quoting
// the same payments row would overwrite/lose that debt and could strand it.
export function hasRecordedRefundDebt(p: PaymentRowSummary): boolean {
  if (p.refund_amount_due != null && Number(p.refund_amount_due) > 0) return true
  if (p.refund_reason) return true
  return false
}

export function paymentNonRequotableReason(p: PaymentRowSummary): string | null {
  if (p.status === "success") return "already_paid"
  if (p.refund_claim_state === "claimed") return "refund_in_progress"
  if (p.refund_status && ["requested", "pending", "queued"].includes(p.refund_status)) {
    return "refund_in_progress"
  }
  // A failed payment that still carries a recorded refund debt must be settled
  // before a new checkout can reuse that row (G-02).
  if (p.status === "failed" && hasRecordedRefundDebt(p)) {
    return "refund_in_progress"
  }
  return null
}

export function refundFieldsPresent(p: PaymentRowSummary): boolean {
  return !!(
    p.refund_status ||
    p.razorpay_refund_id ||
    p.refunded_amount ||
    (p.refund_claim_state && p.refund_claim_state !== "none") ||
    p.refund_reason ||
    (p.refund_amount_due != null && Number(p.refund_amount_due) > 0) ||
    (p.refund_attempt_count != null && Number(p.refund_attempt_count) > 0)
  )
}

export const HTTP_BLOCK: Record<string, number> = {
  already_paid: 409,
  refund_in_progress: 409,
}

// Can a payments row matched ONLY by razorpay_payment_id (fallback match in
// the refund webhook's sync path) be trusted as the target of this refund
// event? Matching by capture id alone is ambiguous: a row re-quoted for a NEW
// sale still carries the PREVIOUS capture's razorpay_payment_id until its own
// capture lands — trusting it there marked the NEW booking 'refunded' (the
// ghost-refund bug). Trust the fallback only when the row is actually inside
// the refund claim machine (claimed/issued/failed) or already refunded.
export function refundSyncRowTrustworthy(row: {
  refund_claim_state?: string | null
  refund_status?: string | null
  status?: string | null
}): boolean {
  return row.refund_claim_state === "claimed" ||
    row.refund_claim_state === "issued" ||
    row.refund_claim_state === "failed" ||
    row.refund_status != null ||
    row.status === "refunded"
}

// Before a re-quote reuses a payment row for a NEW sale, any old refund/claim
// leftovers must be recorded and cleared so a stale refund receipt can never
// bleed into the new attempt (this is what left the old refund as `failed`
// while a fresh sale reused the same row). The prior capture's
// razorpay_payment_id is cleared too: a late refund webhook for the OLD
// payment used to match this row and mark the NEW booking 'refunded' (the
// ghost-refund bug) — the new capture re-populates it on success.
export async function clearRefundFieldsForRequote(
  supabase: SupabaseClient,
  payment: PaymentRowSummary,
): Promise<void> {
  if (!refundFieldsPresent(payment) && !payment.razorpay_payment_id) return
  await supabase.from("payment_audit_log").insert({
    action: "payment_reused_after_refund",
    payment_id: payment.id,
    details: {
      note: "Payment row re-quoted for a new sale — prior refund/claim fields archived and cleared",
      prior_status: payment.status,
      prior_refund_status: payment.refund_status ?? null,
      prior_razorpay_payment_id: payment.razorpay_payment_id ?? null,
      prior_razorpay_refund_id: payment.razorpay_refund_id ?? null,
      prior_refunded_amount: payment.refunded_amount ?? null,
      prior_refund_claim_state: payment.refund_claim_state ?? null,
      prior_refund_reason: payment.refund_reason ?? null,
      prior_refund_amount_due: payment.refund_amount_due ?? null,
      prior_refund_attempt_count: payment.refund_attempt_count ?? null,
    },
  })
  const { error: clearErr } = await supabase.from("payments").update({
    refund_status: null,
    razorpay_payment_id: null,
    razorpay_refund_id: null,
    refunded_amount: null,
    refund_claim_state: "none",
    refund_claim_at: null,
    refund_reason: null,
    refund_amount_due: null,
    refund_attempt_count: 0,
  }).eq("id", payment.id)
  if (clearErr) throw clearErr
}

// Restore a cancelled registration so a new checkout can reuse it. Atomic and
// conditional: the UPDATE only fires when the row is still 'cancelled', so a
// concurrent flow that already moved it (e.g. a cancel racing this restore)
// can never be overwritten from a stale snapshot.
export async function restoreRegistrationIfCancelled(
  supabase: SupabaseClient,
  registrationId: string,
): Promise<void> {
  await supabase.from("registrations").update({
    status: "pending",
    deleted_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", registrationId).eq("status", "cancelled")
}

export async function revertRegistrationToCancelled(
  supabase: SupabaseClient,
  registrationId: string,
): Promise<void> {
  try {
    await supabase.from("registrations").update({
      status: "cancelled",
      updated_at: new Date().toISOString(),
    }).eq("id", registrationId)
  } catch {
    // Best-effort — the pending reg is cleaned up by reconcile later.
  }
}