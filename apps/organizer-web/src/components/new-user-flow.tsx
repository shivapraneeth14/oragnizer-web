import { useState, useCallback, useRef, useEffect } from "react"
import { supabase } from "../supabase"
import CommunityDetailsForm, { initialCommunityData, type CommunityData } from "./community-details-form"

interface Props {
  onBack: () => void
}

export default function NewUserFlow({ onBack }: Props) {
  const [step, setStep] = useState<"register" | "otp" | "community">("register")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [username, setUsername] = useState("")
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null)
  const [checkingUsername, setCheckingUsername] = useState(false)
  const [registerLoading, setRegisterLoading] = useState(false)
  const [registerError, setRegisterError] = useState("")

  const [otp, setOtp] = useState(["", "", "", "", "", ""])
  const [otpLoading, setOtpLoading] = useState(false)
  const [otpError, setOtpError] = useState("")
  const otpRefs = useRef<(HTMLInputElement | null)[]>([])

  const [communityData, setCommunityData] = useState<CommunityData>(initialCommunityData)
  const [communityStep, setCommunityStep] = useState<1 | 2>(1)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState("")
  const [accessToken, setAccessToken] = useState<string | null>(null)

  const usernameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (usernameTimer.current) clearTimeout(usernameTimer.current)
    const u = username.trim()
    if (u.length < 3) { setUsernameAvailable(null); setCheckingUsername(false); return }
    setCheckingUsername(true)
    usernameTimer.current = setTimeout(async () => {
      const { supabaseFetchNoAuth } = await import("../supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/check-username", { username: u })
      const d = await res.json()
      setUsernameAvailable(d.available === true)
      setCheckingUsername(false)
    }, 500)
    return () => { if (usernameTimer.current) clearTimeout(usernameTimer.current) }
  }, [username])

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

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setRegisterError("")
    if (!firstName.trim() || !lastName.trim() || !email.trim() || !password.trim() || !username.trim()) return
    if (usernameAvailable === false) { setRegisterError("This username is already taken."); return }

    setRegisterLoading(true)
    try {
      const { supabaseFetchNoAuth } = await import("../supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/register", {
        email: email.trim(),
        password,
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        username: username.trim(),
      })
      const result = await res.json()
      if (!res.ok) {
        setRegisterError(result.error || "Something went wrong. Try again.")
        return
      }
      setStep("otp")
    } catch {
      setRegisterError("Connection error. Check your internet and try again.")
    } finally {
      setRegisterLoading(false)
    }
  }

  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d?$/.test(value)) return
    const newOtp = [...otp]
    newOtp[index] = value
    setOtp(newOtp)

    if (value && index < 5) {
      otpRefs.current[index + 1]?.focus()
    }
  }

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus()
    }
  }

  const handleVerify = async () => {
    const code = otp.join("")
    if (code.length < 6) return
    setOtpLoading(true)
    setOtpError("")

    const { data, error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code,
      type: "email",
    })

    setOtpLoading(false)
    if (error) {
      setOtpError(error.message.includes("otp")
        ? "Invalid verification code. Please check and try again."
        : error.message)
      return
    }

    if (data.session) {
      setAccessToken(data.session.access_token)
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

  const resendOtp = async () => {
    setOtpLoading(true)
    await supabase.auth.signInWithOtp({ email: email.trim() })
    setOtpLoading(false)
    setOtp(["", "", "", "", "", ""])
  }

  return (
    <div>
      {step !== "otp" && (
        <button type="button" onClick={onBack} className="mb-4 text-sm text-[#C2185B] hover:underline">&larr; Back</button>
      )}

      {step === "register" && (
        <>
          <h2 className="text-xl font-semibold text-neutral-900">Create Account</h2>
          <p className="mt-1 text-sm text-neutral-500">Enter your details to get started.</p>

          <form onSubmit={handleRegister} className="mt-6 space-y-4">
            {registerError && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{registerError}</div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">First name</label>
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="John"
                  className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">Last name</label>
                <input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Doe"
                  className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600">Username</label>
              <div className="relative">
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="johndoe"
                  className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 pr-8 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2">
                  {checkingUsername ? (
                    <svg className="h-4 w-4 animate-spin text-neutral-400" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : usernameAvailable === true ? (
                    <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : usernameAvailable === false ? (
                    <svg className="h-4 w-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  ) : null}
                </span>
              </div>
              {usernameAvailable === false && (
                <p className="mt-0.5 text-xs text-red-500">This username is taken</p>
              )}
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min 8 chars, 1 capital"
                  className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 pr-10 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
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
              <p className="mt-1 text-xs text-neutral-400">8+ characters, 1 capital letter</p>
            </div>

            <button
              type="submit"
              disabled={registerLoading || !firstName.trim() || !lastName.trim() || !email.trim() || !username.trim() || !password.trim() || usernameAvailable === false}
              className="w-full rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50"
            >
              {registerLoading ? "Creating account..." : "Create Account"}
            </button>
          </form>
        </>
      )}

      {step === "otp" && (
        <div className="py-4">
          <h2 className="text-xl font-semibold text-neutral-900">Verify Your Email</h2>
          <p className="mt-1 text-sm text-neutral-500">
            We sent a 6-digit code to <strong>{email}</strong>. Enter it below.
          </p>

          {otpError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{otpError}</div>
          )}

          <div className="mt-6 flex justify-center gap-2">
            {otp.map((digit, i) => (
              <input
                key={i}
                ref={(el) => { otpRefs.current[i] = el }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handleOtpChange(i, e.target.value)}
                onKeyDown={(e) => handleOtpKeyDown(i, e)}
                className="h-12 w-10 rounded-lg border border-neutral-300 text-center text-lg font-semibold outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
              />
            ))}
          </div>

          <button
            type="button"
            onClick={handleVerify}
            disabled={otpLoading || otp.join("").length < 6}
            className="mt-6 w-full rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50"
          >
            {otpLoading ? "Verifying..." : "Verify Email"}
          </button>

          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={resendOtp}
              disabled={otpLoading}
              className="text-sm text-[#C2185B] hover:underline disabled:opacity-50"
            >
              Resend code
            </button>
          </div>
        </div>
      )}

      {step === "community" && (
        <>
          <button type="button" onClick={() => setStep("otp")} className="mb-4 text-sm text-[#C2185B] hover:underline">
            &larr; Back
          </button>
          <h2 className="text-xl font-semibold text-neutral-900">Create Your Community</h2>
          <p className="mt-1 text-sm text-neutral-500">Fill in the details for your new community.</p>

          <div className="mt-6">
            <CommunityDetailsForm
              data={communityData}
              onChange={setCommunityData}
              checkName={checkCommunityName}
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
        </>
      )}
    </div>
  )
}
