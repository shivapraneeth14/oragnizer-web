import type { LegalSection } from "./privacy-content"

// Factual description of the platform fee and settlement model as actually
// implemented (see supabase/functions/_shared/fees.ts). Shown in the
// organizer Settings → Privacy tab (Fees & Payouts dialog). Keep this in
// sync with the real fee code — never promise amounts the system does not
// collect or pay out.

export const feeSections: LegalSection[] = [
  {
    heading: "1. What attendees pay",
    body: (
      <p>
        When someone buys a ticket, they pay the ticket price you set plus a
        Cluvo platform fee (6% of the ticket price by default, calculated after
        any coupon discount). The fee is shown to the attendee as a separate
        line at checkout.
      </p>
    ),
  },
  {
    heading: "2. What you receive",
    body: (
      <p>
        You receive 100% of the ticket price you set. The Cluvo platform fee is
        charged on top of that price — it is not deducted from your share.
        Revenue from paid events is credited to your community wallet.
      </p>
    ),
  },
  {
    heading: "3. Refunds and cancellations",
    body: (
      <p>
        If an attendee cancels their own registration more than 24 hours before
        the event starts, the ticket price is refunded to them and the platform
        fee is kept. If you cancel the event, every non-attended registration is
        refunded in full — including the platform fee — and your wallet is
        debited for the refunded share.
      </p>
    ),
  },
  {
    heading: "4. Contact",
    body: (
      <p>
        Questions about fees or payouts:{" "}
        <a className="text-cluvo-primary underline" href="mailto:supp.cluvo@gmail.com">
          supp.cluvo@gmail.com
        </a>
      </p>
    ),
  },
]
