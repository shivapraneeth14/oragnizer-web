import LegalShell from "../components/legal-shell"
import { privacySections } from "../legal/privacy-content"

export default function PrivacyPolicyPage() {
  return (
    <LegalShell title="Privacy Policy" updated="August 7, 2026">
      <p>
        This Privacy Policy explains how Cluvo ("we", "us") collects, uses, and shares
        information about you when you use the Cluvo mobile app, the organizer web app, and
        related services (together, the "Services"). By using the Services you agree to the
        practices described here.
      </p>
      {privacySections.map((s) => (
        <section key={s.heading}>
          <h2 className="text-lg font-semibold text-neutral-900">{s.heading}</h2>
          <div className="mt-2 space-y-3">{s.body}</div>
        </section>
      ))}
    </LegalShell>
  )
}
