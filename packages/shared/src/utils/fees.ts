// Fee-on-top pricing — the ONE place TypeScript computes money.
// Mirror of supabase/functions/_shared/fees.ts (backend is the authority;
// this copy is for UI previews only — never for charging).
//
//   ticket = price after coupon discount
//   fee    = communities.platform_fee_amount (flat, pre-GST, default ₹20)
//   gst    = 18% of fee, charged to the customer as part of the fee
//   charged to customer = ticket + fee + gst
//   organizer share     = ticket
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
