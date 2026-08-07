import LegalShell from "../components/legal-shell"
import { termsSections } from "../legal/terms-content"

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service" updated="August 7, 2026">
      <p>
        These Terms of Service ("Terms") govern your use of the Cluvo mobile app, the organizer
        web app, and related services (together, the "Services"), operated by Cluvo ("we", "us").
        By using the Services, you agree to these Terms.
      </p>
      {termsSections.map((s) => (
        <section key={s.heading}>
          <h2 className="text-lg font-semibold text-neutral-900">{s.heading}</h2>
          <div className="mt-2 space-y-3">{s.body}</div>
        </section>
      ))}
    </LegalShell>
  )
}
