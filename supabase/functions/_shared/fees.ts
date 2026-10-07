// Fee-on-top pricing — the ONE place edge functions compute money.
//
//   ticket = price after coupon discount
//   fee    = communities.platform_fee_amount (flat, pre-GST, default ₹20)
//   gst    = 18% of fee, charged to the customer as part of the fee
//   charged to customer = ticket + fee + gst
//   organizer share     = ticket
//
// Everything is integer paise. Callers persist the breakdown on the payment
// row at order creation; confirm_payment and every refund path READ those
// columns instead of recomputing (never let the same money math exist twice).
export const PLATFORM_FEE_GST_PERCENT = 18
export const DEFAULT_PLATFORM_FEE_AMOUNT = 2000

export interface FeeBreakdown {
  net: number
  gst: number
  total: number
}

export function feeBreakdown(feeAmountPaise: number | null | undefined): FeeBreakdown {
  const raw = feeAmountPaise ?? DEFAULT_PLATFORM_FEE_AMOUNT
  const parsed = Number(raw)
  const net = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : DEFAULT_PLATFORM_FEE_AMOUNT
  const gst = Math.round((net * PLATFORM_FEE_GST_PERCENT) / 100)
  return { net, gst, total: net + gst }
}

/** Total the customer is charged for one ticket (ticket paise + fee + GST). */
export function chargeForTicket(ticketPaise: number, feeAmountPaise: number | null | undefined): number {
  if (ticketPaise <= 0) return 0
  return ticketPaise + feeBreakdown(feeAmountPaise).total
}
