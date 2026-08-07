import { ReactNode } from "react"

// Single source of truth for the Terms of Service text — rendered by the public
// /terms page AND the in-flow consent dialog (components/legal-dialog.tsx).

const CONTACT_EMAIL = "supp.cluvo@gmail.com"

export interface LegalSection {
  heading: string
  body: ReactNode
}

export const termsSections: LegalSection[] = [
  {
    heading: "1. Eligibility and Accounts",
    body: (
      <p>
        You must be at least 13 years old to use the Services. You are responsible for keeping
        your account credentials confidential and for all activity that occurs under your
        account.
      </p>
    ),
  },
  {
    heading: "2. Communities and Events",
    body: (
      <p>
        Organizers create and manage communities and events, set capacities and prices, and
        are responsible for the accuracy of their listings and for the conduct of their events.
        Attendees register for events and receive tickets subject to the event's own terms.
      </p>
    ),
  },
  {
    heading: "3. Payments, Tickets, and Refunds",
    body: (
      <p>
        Payments for event tickets are processed by Razorpay. All purchases are for attendance
        at physical, in-person events. Refund eligibility and timing are set by the event
        organizer and processed through our payment provider; where we are able, we facilitate
        organizer-initiated refunds. We do not guarantee that any event will take place as
        listed.
      </p>
    ),
  },
  {
    heading: "4. Acceptable Use",
    body: (
      <p>
        You agree not to misuse the Services, including: violating any law; posting
        threatening, harassing, or infringing content; impersonating others; attempting to
        interfere with or break the security of the Services or our providers (including
        Supabase, Cloudinary, Razorpay, and Cashfree); reselling tickets or accounts in
        violation of an event's terms; or using the Services to conduct fraudulent
        transactions.
      </p>
    ),
  },
  {
    heading: "5. Content and Intellectual Property",
    body: (
      <p>
        You retain ownership of content you post. By posting, you grant us a non-exclusive
        license to host, display, and use that content solely to operate the Services. The
        Cluvo name, logos, and the Services themselves are protected by intellectual property
        laws and may not be copied or reused without our permission.
      </p>
    ),
  },
  {
    heading: "6. Disclaimers and Limitation of Liability",
    body: (
      <p>
        The Services are provided "as is" without warranties of any kind, express or implied.
        To the maximum extent permitted by law, we are not liable for indirect, incidental,
        special, or consequential damages, or for losses arising from events, organizers,
        other users, or payment providers. Our total liability is limited to the amount you
        paid to use the Services, if any, in the twelve months preceding the claim.
      </p>
    ),
  },
  {
    heading: "7. Termination",
    body: (
      <p>
        You may stop using the Services at any time and delete your account from within the
        app. We may suspend or terminate access if you violate these Terms.
      </p>
    ),
  },
  {
    heading: "8. Governing Law and Changes",
    body: (
      <p>
        These Terms are governed by the laws of India. We may update these Terms; material
        changes will be posted on this page with an updated "Last updated" date. Continued use
        of the Services after changes constitutes acceptance.
      </p>
    ),
  },
  {
    heading: "9. Contact Us",
    body: (
      <p>
        Questions about these Terms:{" "}
        <a className="text-[#C2185B] underline" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
      </p>
    ),
  },
]
