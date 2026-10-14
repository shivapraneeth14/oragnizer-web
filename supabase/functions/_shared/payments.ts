import type { SupabaseClient } from "jsr:@supabase/supabase-js@2"

export interface PaymentRowSummary {
  id?: string
  status: string | null
  refund_status?: string | null
  refund_claim_state?: string | null
  razorpay_refund_id?: string | null
  refunded_amount?: number | null
}

// A payment row that is paid, or has a refund in flight at the provider, must
// NEVER be demoted to `pending`: re-quoting it would resurrect a cancelled
// booking and hand the user a Pay screen for money that already moved.
// Returns null when re-quote / reuse is allowed.
export function paymentNonRequotableReason(p: PaymentRowSummary): string | null {
  if (p.status === "success") return "already_paid"
  if (p.refund_claim_state === "claimed") return "refund_in_progress"
  if (p.refund_status && ["requested", "pending", "queued"].includes(p.refund_status)) {
    return "refund_in_progress"
  }
  return null
}

export function refundFieldsPresent(p: PaymentRowSummary): boolean {
  return !!(
    p.refund_status ||
    p.razorpay_refund_id ||
    p.refunded_amount ||
    (p.refund_claim_state && p.refund_claim_state !== "none")
  )
}

export const HTTP_BLOCK: Record<string, number> = {
  already_paid: 409,
  refund_in_progress: 409,
}

// Before a re-quote reuses a payment row for a NEW sale, any old refund/claim
// leftovers must be recorded and cleared so a stale refund receipt can never
// bleed into the new attempt (this is what left the old refund as `failed`
// while a fresh sale reused the same row).
export async function clearRefundFieldsForRequote(
  supabase: SupabaseClient,
  payment: PaymentRowSummary,
): Promise<void> {
  if (!refundFieldsPresent(payment)) return
  await supabase.from("payment_audit_log").insert({
    action: "payment_reused_after_refund",
    payment_id: payment.id,
    details: {
      note: "Payment row re-quoted for a new sale — prior refund/claim fields archived and cleared",
      prior_status: payment.status,
      prior_refund_status: payment.refund_status ?? null,
      prior_razorpay_refund_id: payment.razorpay_refund_id ?? null,
      prior_refunded_amount: payment.refunded_amount ?? null,
      prior_refund_claim_state: payment.refund_claim_state ?? null,
    },
  })
  await supabase.from("payments").update({
    refund_status: null,
    razorpay_refund_id: null,
    refunded_amount: null,
    refund_claim_state: "none",
    refund_claim_at: null,
  }).eq("id", payment.id)
}

export async function restoreRegistrationIfCancelled(
  supabase: SupabaseClient,
  registrationId: string,
  currentStatus: string | null,
): Promise<void> {
  if (currentStatus !== "cancelled") return
  await supabase.from("registrations").update({
    status: "pending",
    deleted_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", registrationId)
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