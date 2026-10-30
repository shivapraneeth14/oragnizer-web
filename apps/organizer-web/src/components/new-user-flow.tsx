import { useState, useCallback } from "react"
import { supabase } from "../supabase"
import CommunityDetailsForm, { initialCommunityData, missingCommunityFields, type CommunityData } from "./community-details-form"
import TermsCheckbox from "./terms-checkbox"

interface Props {
  onBack: () => void
  initialData?: CommunityData
  onSubmitted?: (applicationId?: string) => void
}

export default function NewUserFlow({ onBack, initialData, onSubmitted }: Props) {
  const [communityData, setCommunityData] = useState<CommunityData>(initialData || initialCommunityData)
  const [communityStep, setCommunityStep] = useState<1 | 2>(1)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState("")
  const [termsAccepted, setTermsAccepted] = useState(false)

  const checkCommunityName = useCallback(async (name: string): Promise<boolean> => {
    try {
      const { supabaseFetchNoAuth } = await import("../supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/check-community-name", { name })
      const d = await res.json()
      return d.available === true
    } catch {
      return true
    }
  }, [])

  const checkCommunityEmail = useCallback(async (email: string): Promise<boolean> => {
    try {
      const { supabaseFetchNoAuth } = await import("../supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/check-community-email", { email })
      const d = await res.json()
      return d.available === true
    } catch {
      return true
    }
  }, [])

  const handleCreate = async () => {
    if (!termsAccepted) {
      setSubmitError("Please accept the Privacy Policy and Terms of Service to continue.")
      return
    }
    if (!communityData.agree18 || !communityData.agreeContent) return
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

      // Record consent server-side before submitting the community. Idempotent.
      const consentRes = await supabaseFetch("/functions/v1/record-consent", token, { source: "web" })
      if (!consentRes.ok) {
        setSubmitError("Could not record your agreement. Check your connection and try again.")
        return
      }

      const res = await supabaseFetch("/functions/v1/create-community", token, communityData)
      const result = await res.json()
      if (!res.ok) {
        setSubmitError(result.error || "Something went wrong. Try again.")
        return
      }

      if (onSubmitted) {
        onSubmitted(result.application_id)
      } else {
        window.location.reload()
      }
    } catch {
      setSubmitError("Connection error. Check your internet and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-4 text-sm text-cluvo-primary hover:underline">&larr; Back</button>

      <h2 className="text-xl font-semibold text-neutral-900">Create Your Community</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Fill in your community details. Once submitted, our team will review and verify your community.
      </p>

      <div className="mt-6">
        <CommunityDetailsForm
          data={communityData}
          onChange={setCommunityData}
          checkName={checkCommunityName}
          checkEmail={checkCommunityEmail}
          step={communityStep}
        />
      </div>

      <div className="mt-5">
        <TermsCheckbox value={termsAccepted} onChange={setTermsAccepted} />
      </div>

      {submitError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{submitError}</div>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        {communityStep === 2 ? (
          <button
            type="button"
            onClick={() => setCommunityStep(1)}
            className="rounded-lg border border-neutral-300 px-5 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50"
          >
            Previous
          </button>
        ) : (
          <div />
        )}
        {communityStep === 1 ? (
          <button
            type="button"
            onClick={() => setCommunityStep(2)}
            disabled={missingCommunityFields(communityData).step1.length > 0}
            className="rounded-lg bg-cluvo-primary px-6 py-2 text-sm font-medium text-white transition hover:bg-cluvo-primary-dark disabled:opacity-50"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            onClick={handleCreate}
            disabled={submitting || !termsAccepted || missingCommunityFields(communityData).step2.length > 0}
            className="rounded-lg bg-cluvo-primary px-6 py-2 text-sm font-medium text-white transition hover:bg-cluvo-primary-dark disabled:opacity-50"
          >
            {submitting ? "Submitting for Review..." : "Submit for Verification"}
          </button>
        )}
        {(() => {
          const missing = communityStep === 1
            ? missingCommunityFields(communityData).step1
            : missingCommunityFields(communityData).step2
          if (missing.length === 0) return null
          return (
            <div className="mt-3 w-full text-right">
              <p className="text-xs text-neutral-400">Complete: {missing.join(", ")}</p>
            </div>
          )
        })()}
      </div>
    </div>
  )
}
