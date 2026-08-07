import { ReactNode } from "react"

// Single source of truth for the Privacy Policy text — rendered by the public
// /privacy page AND the in-flow consent dialog (components/legal-dialog.tsx).

const CONTACT_EMAIL = "supp.cluvo@gmail.com"

export interface LegalSection {
  heading: string
  body: ReactNode
}

export const privacySections: LegalSection[] = [
  {
    heading: "1. Information We Collect",
    body: (
      <>
        <p>
          <strong>Information you provide:</strong> email address, first and last name, and a
          username; profile and community photos you upload; content you create such as events,
          communities, posts, galleries, and reviews; and optional information you add to your
          profile.
        </p>
        <p>
          <strong>Payment information:</strong> when you buy event tickets, payment is processed
          through Razorpay. Card details and UPI details are entered directly in Razorpay's
          checkout and are not stored on our servers. We store the booking record, the amount,
          the payment status, and refund records (purchase history). Organizers receiving
          payouts are onboarded and paid out through Cashfree.
        </p>
        <p>
          <strong>Sign-in information:</strong> if you sign in with Google, we receive your name
          and email address from your Google account.
        </p>
        <p>
          <strong>Usage information:</strong> your activity in the Services, including events you
          wishlist or register for, notifications you receive, event check-ins, and community
          membership.
        </p>
      </>
    ),
  },
  {
    heading: "2. How We Use Information",
    body: (
      <p>
        We use the information to provide and operate the Services: managing your account,
        communities, events and tickets; processing payments and refunds through Razorpay;
        hosting images through Cloudinary; sending you notifications you have opted into;
        providing customer support; maintaining security and preventing fraud; and improving
        the Services.
      </p>
    ),
  },
  {
    heading: "3. How We Share Information",
    body: (
      <>
        <p>
          We do not sell your personal information. We share it only with service providers
          needed to operate the Services and as required by law:
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li><strong>Razorpay</strong> — payment processing, refunds, and fraud prevention.</li>
          <li><strong>Cloudinary</strong> — image and media hosting.</li>
          <li><strong>Google</strong> — Google Sign-in (if you choose it).</li>
          <li><strong>Cashfree</strong> — payouts to community organizers.</li>
          <li><strong>Supabase</strong> — hosting, authentication, database, and realtime infrastructure for the Services.</li>
        </ul>
        <p>
          We may also disclose information to comply with legal obligations, to enforce our
          Terms, or in connection with a merger, acquisition, or transfer of assets.
        </p>
      </>
    ),
  },
  {
    heading: "4. Retention and Deletion",
    body: (
      <>
        <p>
          You can delete your account at any time from the app (Profile → Delete Account). When
          you do, we permanently remove your profile, wishlist, reviews, notifications, and
          community memberships. Registration and payment records and audit logs are retained
          for legal and financial purposes (for example, tax and refund records) with your
          personal identifiers removed or unlinked so they can no longer be traced to you.
        </p>
        <p>
          To request deletion, correction, or a copy of your data, email{" "}
          <a className="text-[#C2185B] underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </>
    ),
  },
  {
    heading: "5. Children",
    body: (
      <p>
        The Services are intended for users aged 13 and older and are not directed to children
        under 13. If you believe a child under 13 has provided us personal information,
        contact us and we will delete it.
      </p>
    ),
  },
  {
    heading: "6. Security",
    body: (
      <p>
        We use HTTPS encryption for all traffic and store data with access controls (row-level
        security) so that users can only access their own data. No method of transmission or
        storage is completely secure, but we take reasonable measures to protect your
        information.
      </p>
    ),
  },
  {
    heading: "7. Your Rights",
    body: (
      <p>
        Depending on where you live, you may have rights to access, correct, delete, restrict,
        or object to our use of your personal information, and to data portability. You can
        exercise most of these from within the app; otherwise email{" "}
        <a className="text-[#C2185B] underline" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
        . You also have the right to lodge a complaint with your local data protection
        authority.
      </p>
    ),
  },
  {
    heading: "8. International Transfers",
    body: (
      <p>
        Our infrastructure providers (including Supabase) store and process data in multiple
        regions, which may include countries other than the one you live in. By using the
        Services you consent to such transfers.
      </p>
    ),
  },
  {
    heading: "9. Changes to This Policy",
    body: (
      <p>
        We may update this policy from time to time. Material changes will be posted on this
        page with an updated "Last updated" date. Continued use of the Services after changes
        constitutes acceptance of the revised policy.
      </p>
    ),
  },
  {
    heading: "10. Contact Us",
    body: (
      <p>
        Questions or requests regarding this policy or your data:{" "}
        <a className="text-[#C2185B] underline" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
      </p>
    ),
  },
]
