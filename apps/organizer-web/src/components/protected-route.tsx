import { useEffect, useState, type ReactNode } from "react"
import { Navigate } from "react-router-dom"
import { useAuth } from "../auth-context"
import { supabaseFetch } from "../supabase-fetch"

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading, blockSession } = useAuth()
  const [checking, setChecking] = useState(false)
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [deletionGrace, setDeletionGrace] = useState(false)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    setChecking(true)
    setAllowed(null)
    setVerifyError(null)
    setDeletionGrace(false)
    ;(async () => {
      const { checkOrganizerSession } = await import("../supabase-fetch")
      const verdict = await checkOrganizerSession(session.access_token)
      if (cancelled) return
      setChecking(false)
      if (verdict.deletionGrace) {
        setDeletionGrace(true)
        setAllowed(false)
      } else if (verdict.ok && !verdict.organizer) {
        await blockSession(verdict.message)
        setAllowed(false)
      } else if (!verdict.ok && verdict.networkError) {
        // Gate unreachable — deny for now, but let the user retry rather than
        // signing them out over a transient blip.
        setVerifyError(verdict.error)
        setAllowed(false)
      } else if (!verdict.ok) {
        // Reached the server, session rejected (invalid/expired).
        await blockSession(verdict.error ?? verdict.message)
        setAllowed(false)
      } else {
        setAllowed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session?.access_token, blockSession, retryKey])

  if (loading || checking || (session && allowed === null)) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-50">
        <svg className="h-8 w-8 animate-spin text-cluvo-primary" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  if (verifyError) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-50 p-6">
        <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-6 text-center shadow-soft">
          <p className="text-sm text-neutral-600">{verifyError}</p>
          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => {
                setVerifyError(null)
                setAllowed(null)
                setRetryKey((k) => k + 1)
              }}
              className="w-full rounded-lg bg-cluvo-primary px-4 py-2.5 text-sm font-medium text-white transition hover:bg-cluvo-primary-dark"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={async () => {
                await blockSession(verifyError)
                setVerifyError(null)
                setAllowed(false)
              }}
              className="w-full rounded-lg border border-neutral-300 px-4 py-2.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50"
            >
              Sign in again
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (deletionGrace) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-50 p-6">
        <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 text-center shadow-soft">
          <h1 className="text-lg font-semibold text-neutral-900">
            Your account is scheduled for deletion
          </h1>
          <p className="mt-2 text-sm text-neutral-600">
            Your Cluvo account is in its 30-day deletion grace period, so the
            organizer portal is unavailable. You can restore your account from
            the Cluvo mobile app (Profile → Keep my account), or sign in there
            to cancel the deletion.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              onClick={async () => {
                try {
                  const res = await supabaseFetch(
                    "/functions/v1/cancel-account-deletion",
                    session?.access_token,
                    {},
                  )
                  if (res.ok) {
                    setDeletionGrace(false)
                    setAllowed(null)
                    setRetryKey((k) => k + 1)
                  }
                } catch {
                  // Leave the grace screen; the mobile app remains the
                  // reliable restore path.
                }
              }}
              className="w-full rounded-lg bg-cluvo-primary px-4 py-2.5 text-sm font-medium text-white transition hover:bg-cluvo-primary-dark"
            >
              Keep my account
            </button>
            <button
              type="button"
              onClick={async () => {
                await blockSession("Your account is scheduled for deletion.")
                setDeletionGrace(false)
                setAllowed(false)
              }}
              className="w-full rounded-lg border border-neutral-300 px-4 py-2.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!session || allowed === false) return <Navigate to="/" replace />
  return <>{children}</>
}
