import { useState, useEffect } from "react"
import { supabase } from "../supabase"
import { useAuth } from "../auth-context"
import AccountChoice from "../components/account-choice"
import ExistingUserFlow from "../components/existing-user-flow"
import NewUserFlow from "../components/new-user-flow"
import DashboardLogin from "../components/dashboard-login"

type Flow = "choice" | "existing" | "new" | "dashboard-login" | "create"

export default function LandingPage() {
  const { signInWithGoogle } = useAuth()
  const [flow, setFlow] = useState<Flow>("create")
  const [checkingSession, setCheckingSession] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        window.location.href = "/dashboard"
      } else {
        setCheckingSession(false)
      }
    }).catch(() => {
      setCheckingSession(false)
    })
  }, [])

  if (checkingSession) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#C2185B]">
        <svg className="h-8 w-8 animate-spin text-white" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-[#C2185B]">
      <div className="hidden md:flex w-[60%] items-center justify-center">
        <div className="flex flex-col items-start">
          <h1 className="text-8xl font-bold tracking-[0.15em] text-white">
            CLUVO
          </h1>
          <p className="mt-4 text-lg font-light tracking-wider text-white/70">
            Connecting communities
          </p>
        </div>
      </div>

      <div className="flex w-full items-center justify-center md:absolute md:right-0 md:top-0 md:h-full md:w-[42%] md:overflow-visible">
        <div className="w-full max-w-md rounded-none bg-white shadow-2xl md:h-full md:max-w-none md:rounded-l-[140px]">
          <div className="flex h-full flex-col items-center justify-center px-6 py-12 md:px-14">
            <div className="w-full max-w-sm">
              {/* Mobile logo */}
              <div className="mb-8 text-center md:hidden">
                <h1 className="text-4xl font-bold tracking-[0.15em] text-[#C2185B]">CLUVO</h1>
                <p className="mt-2 text-sm font-light tracking-wider text-neutral-500">Connecting communities</p>
              </div>
              {flow === "create" && (
                <div className="flex flex-col items-center py-8">
                  <h2 className="text-xl font-semibold text-neutral-900">Welcome to Cluvo</h2>
                  <p className="mt-2 text-center text-sm text-neutral-500">
                    Create a community or sign in to your dashboard.
                  </p>
                  <button
                    type="button"
                    onClick={() => setFlow("choice")}
                    className="mt-8 w-full rounded-xl bg-[#C2185B] px-6 py-3.5 text-sm font-semibold text-white shadow-md transition hover:bg-[#A0154A]"
                  >
                    Create Community
                  </button>
                  <div className="relative my-6 flex w-full items-center gap-3">
                    <div className="h-px flex-1 bg-neutral-200" />
                    <span className="text-xs text-neutral-400">or</span>
                    <div className="h-px flex-1 bg-neutral-200" />
                  </div>
                  <button
                    type="button"
                    onClick={signInWithGoogle}
                    className="flex w-full items-center justify-center gap-3 rounded-xl border border-neutral-300 px-6 py-3.5 text-sm font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50"
                  >
                    <svg className="h-5 w-5" viewBox="0 0 24 24">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    Continue with Google
                  </button>
                  <p className="mt-6 text-sm text-neutral-400">
                    Already have a community?{" "}
                    <button
                      type="button"
                      onClick={() => setFlow("dashboard-login")}
                      className="text-[#C2185B] hover:underline"
                    >
                      Sign in to dashboard
                    </button>
                  </p>
                </div>
              )}
              {flow === "choice" && (
                <div>
                  <button type="button" onClick={() => setFlow("create")} className="mb-4 text-sm text-[#C2185B] hover:underline">
                    &larr; Back
                  </button>
                  <AccountChoice
                    onChoice={(hasAccount) => setFlow(hasAccount ? "existing" : "new")}
                  />
                </div>
              )}
              {flow === "existing" && (
                <ExistingUserFlow onBack={() => setFlow("choice")} />
              )}
              {flow === "new" && (
                <NewUserFlow onBack={() => setFlow("choice")} />
              )}
              {flow === "dashboard-login" && (
                <DashboardLogin onBack={() => setFlow("create")} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
