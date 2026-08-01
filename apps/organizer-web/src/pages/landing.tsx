import { useState, useEffect } from "react"
import { supabase } from "../supabase"
import { useAuth } from "../auth-context"
import AccountChoice from "../components/account-choice"
import ExistingUserFlow from "../components/existing-user-flow"
import NewUserFlow from "../components/new-user-flow"
import DashboardLogin from "../components/dashboard-login"

type Flow = "choice" | "existing" | "new" | "dashboard-login" | "create"

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

function deriveNames(meta: Record<string, unknown>): { first_name: string; last_name: string } {
  const given = typeof meta.given_name === "string" ? meta.given_name : null
  const family = typeof meta.family_name === "string" ? meta.family_name : null
  if (given) return { first_name: given, last_name: family ?? "" }
  const full =
    (typeof meta.name === "string" ? meta.name : typeof meta.full_name === "string" ? meta.full_name : "").trim()
  const parts = full.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return { first_name: parts[0], last_name: parts.slice(1).join(" ") }
  if (parts.length === 1) return { first_name: parts[0], last_name: "" }
  return { first_name: "", last_name: "" }
}

export default function LandingPage() {
  const { signInWithGoogle, signOut, user } = useAuth()
  const [flow, setFlow] = useState<Flow>("create")
  const [checkingSession, setCheckingSession] = useState(true)
  const [activeTab, setActiveTab] = useState<"explore" | "organizer">("explore")
  const [prefill, setPrefill] = useState<{ email: string; first_name: string; last_name: string } | null>(null)
  const [initialStep, setInitialStep] = useState<"register" | "community">("register")

  useEffect(() => {
    const isOAuthReturn = new URLSearchParams(window.location.search).get("oauth") === "1"
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) {
        if (isOAuthReturn) history.replaceState({}, "", window.location.pathname)
        setCheckingSession(false)
        return
      }
      history.replaceState({}, "", window.location.pathname)
      const [profileRes, communityRes] = await Promise.all([
        supabase.from("profiles").select("username").eq("id", user.id).maybeSingle(),
        supabase.from("communities").select("id").eq("owner_id", user.id).maybeSingle(),
      ])
      const username = profileRes.data && (profileRes.data as { username: string | null }).username
      const ownsCommunity = !!communityRes.data
      if (username && ownsCommunity) {
        window.location.href = "/dashboard"
        return
      }
      if (!username) {
        const names = deriveNames(user.user_metadata ?? {})
        setPrefill({ email: user.email ?? "", ...names })
      }
      setInitialStep(username ? "community" : "register")
      setFlow("new")
      setCheckingSession(false)
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
    <div className="bg-[#C2185B]">
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
              <div className="flex justify-end px-6 pt-4">
                <button
                  type="button"
                  onClick={() => { signOut(); setFlow("create") }}
                  className="text-xs text-neutral-400 transition hover:text-neutral-600"
                >
                  Sign out
                </button>
              </div>
            )}
            <div className="flex-1 flex items-center justify-center px-6 py-12 md:px-14">
              <div className="w-full max-w-sm mx-auto">
                <div className="mb-8 text-center md:hidden">
                  <h1 className="text-4xl font-bold tracking-[0.15em] text-[#C2185B]">CLUVO</h1>
                  <p className="mt-2 text-sm font-light tracking-wider text-neutral-500">Connecting communities</p>
                </div>

                <div className="mb-8 flex items-center justify-center gap-3 text-sm">
                  <button
                    type="button"
                    onClick={() => setActiveTab("explore")}
                    className={`transition-colors ${activeTab === "explore" ? "font-medium text-[#C2185B]" : "text-neutral-500 hover:text-neutral-700"}`}
                  >
                    Explore Community
                  </button>
                  <span className="text-neutral-300">|</span>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("organizer"); setFlow("create") }}
                    className={`transition-colors ${activeTab === "organizer" ? "font-medium text-[#C2185B]" : "text-neutral-500 hover:text-neutral-700"}`}
                  >
                    Become an Organizer
                  </button>
                </div>

                {activeTab === "explore" ? (
                  <ExploreCommunityContent />
                ) : (
                  <>
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
                      <NewUserFlow onBack={() => setFlow("choice")} prefill={prefill} initialStep={initialStep} />
                    )}
                    {flow === "dashboard-login" && (
                      <DashboardLogin onBack={() => setFlow("create")} />
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <FeaturesSection />
    </div>
  )
}

function ExploreCommunityContent() {
  const deeplink = import.meta.env.VITE_APP_DEEPLINK_BASE || "cluvo://"

  const handleOpenApp = () => {
    window.location.href = "https://cluvo-sand.vercel.app"
  }

  return (
    <div className="flex flex-col items-center py-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#C2185B]/10">
        <svg className="h-8 w-8 text-[#C2185B]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      </div>
      <h2 className="mt-6 text-xl font-semibold text-neutral-900">Join a Community</h2>
      <p className="mt-2 text-center text-sm text-neutral-500">
        Browse communities, discover events, and connect with people near you.
      </p>
      <button
        type="button"
        onClick={handleOpenApp}
        className="mt-8 w-full rounded-xl bg-[#C2185B] px-6 py-3.5 text-sm font-semibold text-white shadow-md transition hover:bg-[#A0154A]"
      >
        Open Cluvo App
      </button>
      <p className="mt-4 text-center text-xs text-neutral-400">
        Download the Cluvo mobile app from the App Store or Google Play.
      </p>
      <div className="mt-4 flex gap-3">
        <a
          href="#"
          className="flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
          </svg>
          App Store
        </a>
        <a
          href="#"
          className="flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.199l2.807 1.626a1 1 0 010 1.732l-2.807 1.626L15.206 12l2.492-2.492zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z"/>
          </svg>
          Google Play
        </a>
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
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#C2185B]/10">
                <svg className="h-6 w-6 text-[#C2185B]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
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
