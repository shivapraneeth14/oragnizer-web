// Pending-payment resolution shared by reconcile-payments.
//
// G-01: a payment is never given up on (marked failed, registration cancelled)
// until Razorpay proves no money was captured. Age alone is not proof. The
// same resolver now covers every stale pending payment, so a paid order can no
// longer fall through a ">2h, assume unpaid" gap.

export const PENDING_GIVE_UP_AFTER_MS = 2 * 60 * 60 * 1000

export interface ProviderOrder {
  status?: string | null
  amount_paid?: number | null
}

export interface ProviderPayment {
  id: string
  status?: string | null
  amount?: number | null
}

export interface PendingPaymentRow {
  id: string
  razorpay_order_id: string | null
  registration_id: string | null
  coupon_id: string | null
  created_at: string
}

export type PendingDecision =
  | { action: "confirm" }
  | { action: "wait" }
  | { action: "expire" }
  | { action: "manual"; reason: "paid_without_captured_payment" }

export interface DecidePendingInput {
  orderStatus?: string | null
  amountPaid?: number | null
  hasCapturedPayment: boolean
  ageMs: number
}

// The single decision point. "expire" is only reachable when the provider did
// NOT report a paid order; a paid order without a visible capture is flipped
// to manual review instead of being cancelled.
export function decidePendingPayment(input: DecidePendingInput): PendingDecision {
  const paid = input.orderStatus === "paid" && Number(input.amountPaid ?? 0) > 0

  if (!paid) {
    return input.ageMs >= PENDING_GIVE_UP_AFTER_MS
      ? { action: "expire" }
      : { action: "wait" }
  }

  return input.hasCapturedPayment
    ? { action: "confirm" }
    : { action: "manual", reason: "paid_without_captured_payment" }
}

export interface PendingDeps {
  getOrder(orderId: string): Promise<ProviderOrder | null>
  listOrderPayments(orderId: string): Promise<ProviderPayment[]>
  setCapturedPaymentId(paymentId: string, capturedPaymentId: string): Promise<void>
  /** Returns the confirm_payment RPC jsonb body (or a transport error). */
  confirmPayment(paymentId: string): Promise<{ action?: string; error?: string; skipped?: boolean } | null>
  /** Guarded: true only when the row was still 'pending' and became 'failed'. */
  markExpired(paymentId: string): Promise<boolean>
  cancelRegistration(registrationId: string): Promise<void>
  releaseCoupon(couponId: string): Promise<void>
  audit(action: string, paymentId: string, details: Record<string, unknown>): Promise<void>
  now?(): number
}

export type PendingOutcome =
  | { action: "confirmed" }
  | { action: "already_confirmed" }
  | { action: "refund_required"; paymentId: string; amount: number }
  | { action: "expired" }
  | { action: "wait"; reason?: string }
  | { action: "manual"; reason: string; error?: string }

export async function resolvePendingPayment(
  pay: PendingPaymentRow,
  deps: PendingDeps,
): Promise<PendingOutcome> {
  if (!pay.razorpay_order_id) return { action: "wait", reason: "no_order_id" }

  let order: ProviderOrder | null
  try {
    order = await deps.getOrder(pay.razorpay_order_id)
  } catch (err) {
    // Cannot see the provider: never write a terminal state on a guess.
    return { action: "wait", reason: errorMessage(err) }
  }

  const ageMs = (deps.now?.() ?? Date.now()) - new Date(pay.created_at).getTime()
  const paid = order?.status === "paid" && Number(order?.amount_paid ?? 0) > 0

  let captured: ProviderPayment | undefined
  if (paid) {
    try {
      captured = (await deps.listOrderPayments(pay.razorpay_order_id))
        .find((p) => p.status === "captured")
    } catch (err) {
      // Paid but the capture is not visible (provider lag). Waiting is the only
      // safe action — never cancel a paid customer's booking on this.
      return { action: "wait", reason: errorMessage(err) }
    }
  }

  const decision = decidePendingPayment({
    orderStatus: order?.status,
    amountPaid: order?.amount_paid,
    hasCapturedPayment: Boolean(captured),
    ageMs,
  })

  if (decision.action === "wait") return { action: "wait" }
  if (decision.action === "manual") return { action: "manual", reason: decision.reason }

  if (decision.action === "confirm" && captured) {
    await deps.setCapturedPaymentId(pay.id, captured.id)
    const result = await deps.confirmPayment(pay.id)

    if (result?.error) {
      return { action: "manual", reason: "confirm_failed", error: result.error }
    }
    if (result?.skipped) return { action: "already_confirmed" }
    if (result?.action === "refund_required") {
      return {
        action: "refund_required",
        paymentId: pay.id,
        amount: Number(captured.amount ?? order?.amount_paid ?? 0),
      }
    }
    return { action: "confirmed" }
  }

  // The provider confirms nothing was captured and the order is past the
  // give-up window. The write is guarded, so a payment confirmed by a webhook
  // in the meantime wins and its registration is left alone.
  const expired = await deps.markExpired(pay.id)
  if (!expired) return { action: "wait", reason: "race_lost" }

  if (pay.registration_id) await deps.cancelRegistration(pay.registration_id)
  if (pay.coupon_id) await deps.releaseCoupon(pay.coupon_id)
  await deps.audit("payment_reconcile_gave_up", pay.id, {
    note: "Pending >2h — Razorpay confirms no payment was captured; registration cancelled",
  })
  return { action: "expired" }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
