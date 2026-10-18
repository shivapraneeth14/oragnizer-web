// Percent platform fee — the ONE place TypeScript computes money.
// Mirror of supabase/functions/_shared/fees.ts (backend is the authority;
// this copy is for UI previews only — never for charging).
//
//   ticket (T) = price after coupon discount
//   fee (F)    = round(T * communities.commission_percent / 100), charged ON TOP
//   charged to customer = T + F        -> payments.amount
//   organizer share     = T            -> payments.organizer_share
//   platform fee        = F            -> payments.platform_fee (no GST)
export const DEFAULT_COMMISSION_PERCENT = 6

export interface FeeBreakdown {
  net: number
  gst: number
  total: number
}

/** Platform fee for one ticket: commission_percent of the (post-coupon) ticket. */
export function platformFeeForTicket(
  ticketPaise: number,
  commissionPercent: number | null | undefined,
): FeeBreakdown {
  const raw = commissionPercent ?? DEFAULT_COMMISSION_PERCENT
  const parsed = Number(raw)
  const pct = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 100) : DEFAULT_COMMISSION_PERCENT
  const ticket = Number.isFinite(Number(ticketPaise)) ? Math.max(0, Math.trunc(Number(ticketPaise))) : 0
  const net = Math.round((ticket * pct) / 100)
  return { net, gst: 0, total: net }
}
