import { useState, useEffect } from "react"
import { Link } from "react-router-dom"
import { supabase } from "../supabase"
import CommunityDetailsForm, { initialCommunityData, type CommunityData } from "./community-details-form"

interface Props {
  onBack: () => void
}

export default function ExistingUserFlow({ onBack }: Props) {
  const [step, setStep] = useState<"login" | "community">("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState("")
  const [communityData, setCommunityData] = useState<CommunityData>(initialCommunityData)
  const [communityStep, setCommunityStep] = useState<1 | 2>(1)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState("")
  const [accessToken, setAccessToken] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setAccessToken(session.access_token)
    })
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginError("")
    if (!email.trim() || !password.trim()) return
    setLoginLoading(true)
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    setLoginLoading(false)
    if (error) {
      const msg = error.message.includes("Invalid login credentials")
        ? "Invalid email or password. Please try again."
        : error.message.includes("Email not confirmed")
          ? "Please confirm your email address."
          : error.message
      setLoginError(msg)
      return
    }
    if (data.session) {
      setAccessToken(data.session.access_token)
      const { supabaseFetch } = await import("../supabase-fetch")
      const res = await supabaseFetch("/functions/v1/check-ownership", data.session.access_token, {})
      const result = await res.json()
      if (result.hasCommunity) {
        setLoginError("You already own a community. Each account can only create one.")
        return
      }
      setStep("community")
    }
  }

  const handleCreate = async () => {
    if (!communityData.agree18 || !communityData.agreeContent || !accessToken) return
    setSubmitting(true)
    setSubmitError("")
    try {
      const { supabaseFetch } = await import("../supabase-fetch")
      const res = await supabaseFetch("/functions/v1/create-community", accessToken, communityData)
      const result = await res.json()
      if (!res.ok) {
        setSubmitError(result.error || "Something went wrong. Try again.")
        return
      }
      window.location.href = "/dashboard"
    } catch {
      setSubmitError("Connection error. Check your internet and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (step === "login") {
    return (
      <div>
        <button type="button" onClick={onBack} className="mb-4 text-sm text-[#C2185B] hover:underline">&larr; Back</button>
        <h2 className="text-xl font-semibold text-neutral-900">Sign In</h2>
        <p className="mt-1 text-sm text-neutral-500">Enter your credentials to continue.</p>

        <form onSubmit={handleLogin} className="mt-6 space-y-4">
          {loginError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{loginError}</div>
          )}

          <div>
            <label className="mb-1.5 block text-sm font-medium text-neutral-700">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-neutral-700">Password</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 pr-10 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
              >
                {showPassword ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div className="text-right">
            <Link to="/forgot-password" className="inline-block text-sm text-[#C2185B] hover:underline">
              Forgot password?
            </Link>
          </div>

          <button
            type="submit"
            disabled={loginLoading || !email.trim() || !password.trim()}
            className="w-full rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50"
          >
            {loginLoading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div>
      <button type="button" onClick={() => setStep("login")} className="mb-4 text-sm text-[#C2185B] hover:underline">&larr; Back</button>
      <h2 className="text-xl font-semibold text-neutral-900">Create Your Community</h2>
      <p className="mt-1 text-sm text-neutral-500">Fill in the details for your new community.</p>

      <div className="mt-6">
        <CommunityDetailsForm
          data={communityData}
          onChange={setCommunityData}
          checkName={async (name) => {
            const { supabaseFetchNoAuth } = await import("../supabase-fetch")
            const res = await supabaseFetchNoAuth("/functions/v1/check-community-name", { name })
            const d = await res.json()
            return d.available === true
          }}
          checkEmail={async (email) => {
            const { supabaseFetchNoAuth } = await import("../supabase-fetch")
            const res = await supabaseFetchNoAuth("/functions/v1/check-community-email", { email })
            const d = await res.json()
            return d.available === true
          }}
          step={communityStep}
        />
      </div>

      {submitError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{submitError}</div>
      )}

      <div className="mt-6 flex items-center justify-between">
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
            disabled={!communityData.community_name.trim()}
            className="rounded-lg bg-[#C2185B] px-6 py-2 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            onClick={handleCreate}
            disabled={submitting || !communityData.agree18 || !communityData.agreeContent}
            className="rounded-lg bg-[#C2185B] px-6 py-2 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50"
          >
            {submitting ? "Creating..." : "Create Community"}
          </button>
        )}
      </div>
    </div>
  )
}
