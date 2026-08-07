import LegalShell from "../components/legal-shell"

const CONTACT_EMAIL = "supp.cluvo@gmail.com"

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-neutral-900">{heading}</h2>
      <div className="mt-2 space-y-3">{children}</div>
    </section>
  )
}

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service" updated="August 7, 2026">
      <p>
        These Terms of Service ("Terms") govern your use of the Cluvo mobile app, the organizer
        web app, and related services (together, the "Services"), operated by Cluvo ("we", "us").
        By using the Services, you agree to these Terms.
      </p>

      <Section heading="1. Eligibility and Accounts">
        <p>
          You must be at least 13 years old to use the Services. You are responsible for keeping
          your account credentials confidential and for all activity that occurs under your
          account.
        </p>
      </Section>

      <Section heading="2. Communities and Events">
        <p>
          Organizers create and manage communities and events, set capacities and prices, and
          are responsible for the accuracy of their listings and for the conduct of their events.
          Attendees register for events and receive tickets subject to the event's own terms.
        </p>
      </Section>

      <Section heading="3. Payments, Tickets, and Refunds">
        <p>
          Payments for event tickets are processed by Razorpay. All purchases are for
          attendance at physical, in-person events. Refund eligibility and timing are set by the
          event organizer and processed through our payment provider; where we are able, we
          facilitate organizer-initiated refunds. We do not guarantee that any event will take
          place as listed.
        </p>
      </Section>

      <Section heading="4. Acceptable Use">
        <p>
          You agree not to misuse the Services, including: violating any law; posting
          threatening, harassing, or infringing content; impersonating others; attempting to
          interfere with or break the security of the Services or our providers (including
          Supabase, Cloudinary, Razorpay, and Cashfree); reselling tickets or accounts in
          violation of an event's terms; or using the Services to conduct fraudulent
          transactions.
        </p>
      </Section>

      <Section heading="5. Content and Intellectual Property">
        <p>
          You retain ownership of content you post. By posting, you grant us a non-exclusive
          license to host, display, and use that content solely to operate the Services. The
          Cluvo name, logos, and the Services themselves are protected by intellectual property
          laws and may not be copied or reused without our permission.
        </p>
      </Section>

      <Section heading="6. Disclaimers and Limitation of Liability">
        <p>
          The Services are provided "as is" without warranties of any kind, express or implied.
          To the maximum extent permitted by law, we are not liable for indirect, incidental,
          special, or consequential damages, or for losses arising from events, organizers,
          other users, or payment providers. Our total liability is limited to the amount you
          paid to use the Services, if any, in the twelve months preceding the claim.
        </p>
      </Section>

      <Section heading="7. Termination">
        <p>
          You may stop using the Services at any time and delete your account from within the
          app. We may suspend or terminate access if you violate these Terms.
        </p>
      </Section>

      <Section heading="8. Governing Law and Changes">
        <p>
          These Terms are governed by the laws of India. We may update these Terms; material
          changes will be posted on this page with an updated "Last updated" date. Continued use
          of the Services after changes constitutes acceptance.
        </p>
      </Section>

      <Section heading="9. Contact Us">
        <p>
          Questions about these Terms:{" "}
          <a className="text-[#C2185B] underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
        </p>
      </Section>
    </LegalShell>
  )
}
