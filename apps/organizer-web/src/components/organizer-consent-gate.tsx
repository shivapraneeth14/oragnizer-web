import { useState } from "react"
import { supabase } from "../supabase"
import { useAuth } from "../auth-context"
import TermsCheckbox from "./terms-checkbox"

interface Props {
  onBack: () => void
}

// Shown to EXISTING organizers (users who already own a community) when the
// server reports their recorded consent is missing or for an older policy
// version. Mirrors the acceptance step of NewUserFlow: tick the box (reading
// the full texts in dialogs), record consent server-side, then continue to
// the dashboard.
export default function OrganizerConsentGate({ onBack }: Props) {
  const { signOut } = useAuth()
  const [accepted, setAccepted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState("")

  const handleAccept = async () => {
    if (!accepted) {
      setSubmitError("Please accept the Privacy Policy and Terms of Service to continue.")
      return
    }
    setSubmitting(true)
    setSubmitError("")
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token ?? null
      if (!token) {
        setSubmitError("Please sign in to continue.")
        return
      }
      const { supabaseFetch } = await import("../supabase-fetch")
      const res = await supabaseFetch("/functions/v1/record-consent", token, { source: "web" })
      if (!res.ok) {
        setSubmitError("Could not record your agreement. Check your connection and try again.")
        return
      }
      window.location.href = "/dashboard"
    } catch {
      setSubmitError("Connection error. Check your internet and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => { signOut(); onBack() }}
        className="mb-4 text-sm text-neutral-500 hover:underline"
      >
        &larr; Sign out
      </button>

      <h2 className="text-xl font-semibold text-neutral-900">Agree to our policies</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Please review and agree to our policies before continuing to your dashboard.
      </p>

      <div className="mt-6">
        <TermsCheckbox value={accepted} onChange={setAccepted} />
      </div>

      {submitError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{submitError}</div>
      )}

      <button
        type="button"
        onClick={handleAccept}
        disabled={submitting || !accepted}
        className="mt-6 w-full rounded-lg bg-cluvo-primary px-6 py-2.5 text-sm font-medium text-white transition hover:bg-cluvo-primary-dark disabled:opacity-50"
      >
        {submitting ? "Saving..." : "I Agree & Continue"}
      </button>
    </div>
  )
}
