import { useEffect, useState, type ReactNode } from "react"
import { Navigate } from "react-router-dom"
import { useAuth } from "../auth-context"

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading, blockSession } = useAuth()
  const [checking, setChecking] = useState(false)
  const [allowed, setAllowed] = useState<boolean | null>(null)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    setChecking(true)
    setAllowed(null)
    ;(async () => {
      const { checkOrganizerSession } = await import("../supabase-fetch")
      const verdict = await checkOrganizerSession(session.access_token)
      if (cancelled) return
      setChecking(false)
      if (verdict.ok && !verdict.organizer) {
        await blockSession(verdict.message)
        setAllowed(false)
      } else {
        setAllowed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session?.access_token, blockSession])

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

  if (!session || allowed === false) return <Navigate to="/" replace />
  return <>{children}</>
}
