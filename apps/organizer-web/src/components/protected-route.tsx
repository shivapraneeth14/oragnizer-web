import { useEffect, useState, type ReactNode } from "react"
import { Navigate } from "react-router-dom"
import { useAuth } from "../auth-context"

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading, blockSession } = useAuth()
  const [checking, setChecking] = useState(false)
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    setChecking(true)
    setAllowed(null)
    setVerifyError(null)
    ;(async () => {
      const { checkOrganizerSession } = await import("../supabase-fetch")
      const verdict = await checkOrganizerSession(session.access_token)
      if (cancelled) return
      setChecking(false)
      if (verdict.ok && !verdict.organizer) {
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

  if (loading || checking) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-50">
        <svg className="h-8 w-8 animate-spin text-[#C2185B]" viewBox="0 0 24 24" fill="none">
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
              className="w-full rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A]"
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

  if (!session || allowed === false) return <Navigate to="/" replace />
  return <>{children}</>
}
