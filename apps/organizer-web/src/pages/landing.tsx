import { useState, useEffect, useRef } from "react"
import { Link } from "react-router-dom"
import { supabase } from "../supabase"
import { useAuth } from "../auth-context"
import EmailFirst from "../components/email-first"
import NewUserFlow from "../components/new-user-flow"
import OrganizerConsentGate from "../components/organizer-consent-gate"

type Flow = "auth" | "new" | "consent"

const features = [
  {
    svg: "M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z",
    title: "Communities",
    desc: "Create and manage your own communities with ease.",
  },
  {
    svg: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
    title: "Events & Ticketing",
    desc: "Host events with ticketing, capacity controls, and QR check-in.",
  },
  {
    svg: "M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z",
    title: "Members",
    desc: "Invite members, assign roles, and grow your community.",
  },
  {
    svg: "M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z",
    title: "Media & Gallery",
    desc: "Share photos, videos, and galleries with your community.",
  },
  {
    svg: "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z",
    title: "Payments & Payouts",
    desc: "Collect payments and get payouts directly to your account.",
  },
  {
    svg: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
    title: "Analytics",
    desc: "Track attendance, revenue, and growth insights.",
  },
]

export default function LandingPage() {
  const { signOut, user, loading } = useAuth()
  const [flow, setFlow] = useState<Flow>("auth")
  const [checkingSession, setCheckingSession] = useState(true)
  const decidedForUserRef = useRef<string | null>(null)
  const runIdRef = useRef(0)

  const userId = user?.id

  useEffect(() => {
    // Wait for the auth provider to settle: an OAuth return populates the
    // session asynchronously (onAuthStateChange), so a one-shot getUser() can
    // still see a stale/previous user and mis-route.
    if (loading) return

    const isOAuthReturn = new URLSearchParams(window.location.search).get("oauth") === "1"

    if (!userId) {
      decidedForUserRef.current = null
      if (isOAuthReturn) history.replaceState({}, "", window.location.pathname)
      setCheckingSession(false)
      return
    }

    // Decide once per user id. Keying on the id (not the user object) is what
    // makes an OAuth return work: onAuthStateChange emits SIGNED_IN and then the
    // mount getUser() resolves with a *new* user object for the same id, so
    // depending on the object would re-run this effect and cancel the in-flight
    // role query — leaving the spinner stuck forever. runId discards a stale
    // query result if the user changes mid-flight (no cleanup cancellation, so
    // React StrictMode's synthetic remount cannot strand the spinner either).
    if (decidedForUserRef.current === userId) return
    decidedForUserRef.current = userId
    const runId = ++runIdRef.current

    ;(async () => {
      history.replaceState({}, "", window.location.pathname)
      // Owning a community is the organizer signal. Check the array (limit 1)
      // rather than maybeSingle(), which errors if an owner ever had 2+ rows.
      const { data: communityRes, error: commError } = await supabase
        .from("communities")
        .select("id")
        .eq("owner_id", userId)
        .limit(1)
      if (runId !== runIdRef.current) return
      let ownsCommunity = Array.isArray(communityRes) && communityRes.length > 0
      if (!ownsCommunity && commError) {
        try {
          const { data: { session } } = await supabase.auth.getSession()
          if (session?.access_token) {
            const { checkOrganizerSession } = await import("../supabase-fetch")
            const verdict = await checkOrganizerSession(session.access_token)
            if (verdict.organizer) ownsCommunity = true
          }
        } catch {
          // ignore fallback error
        }
      }
      if (ownsCommunity) {
        // Organizer consent gate: existing organizers must have a consent
        // record for the CURRENT policy version before entering the dashboard
        // (closes the "existing organizer skips the terms checkbox" bypass).
        let upToDate = false
        try {
          const { data: { session } } = await supabase.auth.getSession()
          if (session?.access_token) {
            const { env } = await import("../config")
            const res = await fetch(`${env.supabaseUrl}/functions/v1/record-consent`, {
              method: "GET",
              headers: { Authorization: `Bearer ${session.access_token}` },
            })
            if (res.ok) {
              const data = await res.json().catch(() => ({}))
              upToDate = data?.upToDate === true
            } else {
              // Server reachable but rejected — treat as not up to date so
              // the user can re-accept (record-consent POST is idempotent).
              upToDate = false
            }
          }
        } catch {
          // Network error: fail open to the dashboard to avoid locking the
          // organizer out offline. Server-side booking/payment functions
          // still enforce the presence of a consent record.
          upToDate = true
        }
        if (runId !== runIdRef.current) return
        if (upToDate) {
          window.location.href = "/dashboard"
          return
        }
        setFlow("consent")
        setCheckingSession(false)
        return
      }
      // Not an organizer yet — send them straight to the community form. There
      // is no customer-account check and no separate registration step.
      setFlow("new")
      setCheckingSession(false)
    })().catch(() => {
      if (runId === runIdRef.current) setCheckingSession(false)
    })
  }, [userId, loading])

  if (checkingSession) {
    return (
      <div className="flex h-screen items-center justify-center bg-cluvo-primary">
        <svg className="h-8 w-8 animate-spin text-white" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="bg-cluvo-primary">
      <div className="flex min-h-screen flex-col md:flex-row">
        <div className="hidden md:flex md:w-[58%] items-center justify-center">
          <div className="flex flex-col items-start">
            <h1 className="text-8xl font-bold tracking-[0.15em] text-white">
              CLUVO
            </h1>
            <p className="mt-4 text-lg font-light tracking-wider text-white/70">
              Connecting communities
            </p>
          </div>
        </div>

        <div className="flex w-full md:w-[42%]">
          <div className="w-full bg-white shadow-2xl md:rounded-l-[140px] md:min-h-screen flex flex-col">
            {user && (
              <div className="flex items-center justify-end gap-3 px-6 pt-4">
                <span className="text-xs text-neutral-400">Signed in as {user.email}</span>
                <button
                  type="button"
                  onClick={() => { signOut(); setFlow("auth") }}
                  className="text-xs text-neutral-400 transition hover:text-neutral-600"
                >
                  Sign out
                </button>
              </div>
            )}
            <div className="flex-1 flex items-center justify-center px-6 py-12 md:px-14">
              <div className="w-full max-w-sm mx-auto">
                <div className="mb-8 text-center md:hidden">
                  <h1 className="text-4xl font-bold tracking-[0.15em] text-cluvo-primary">CLUVO</h1>
                  <p className="mt-2 text-sm font-light tracking-wider text-neutral-500">Connecting communities</p>
                </div>

                {flow === "auth" && <EmailFirst />}
                {flow === "new" && <NewUserFlow onBack={() => setFlow("auth")} />}
                {flow === "consent" && (
                  <OrganizerConsentGate onBack={() => setFlow("auth")} />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <FeaturesSection />
      <LegalFooter />
    </div>
  )
}

function LegalFooter() {
  return (
    <div className="border-t border-white/15 bg-cluvo-primary-dark px-6 py-6">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 text-sm text-white/70 sm:flex-row">
        <span>&copy; {new Date().getFullYear()} Cluvo</span>
        <div className="flex items-center gap-6">
          <Link to="/privacy" className="transition hover:text-white">
            Privacy Policy
          </Link>
          <Link to="/terms" className="transition hover:text-white">
            Terms
          </Link>
          <a href="mailto:supp.cluvo@gmail.com" className="transition hover:text-white">
            Contact
          </a>
        </div>
      </div>
    </div>
  )
}

function FeaturesSection() {
  return (
    <div className="bg-white py-24 px-6">
      <div className="mx-auto max-w-6xl">
        <div className="text-center">
          <h2 className="text-3xl font-bold text-neutral-900">Everything you need to run a community</h2>
          <p className="mt-4 text-lg text-neutral-500">
            From events to payments, Cluvo has you covered.
          </p>
        </div>
        <div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft transition hover:shadow-medium">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-cluvo-primary/10">
                <svg className="h-6 w-6 text-cluvo-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={f.svg} />
                </svg>
              </div>
              <h3 className="mt-4 text-lg font-semibold text-neutral-900">{f.title}</h3>
              <p className="mt-2 text-sm text-neutral-500">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
