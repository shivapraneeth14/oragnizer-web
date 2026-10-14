import { useEffect, useRef, useState } from "react"
import { useAuth } from "../auth-context"

type Step = "email" | "otp" | "password"

interface Props {
  open: boolean
  onClose: () => void
  requireOrganizer?: boolean
  onSuccessEmail?: (email: string) => void
}

const TTL_MS = 600_000 // 10 minutes, matches the server
const RESEND_MS = 30_000
const DEFAULT_MESSAGE =
  "If your email uses password login, a verification code has been sent. If it uses Google, please sign in with Google instead."

function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}

const inputCls =
  "w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-cluvo-primary focus:ring-1 focus:ring-cluvo-primary/20"
const labelCls = "mb-1.5 block text-sm font-medium text-neutral-700"

export default function PasswordResetModal({
  open,
  onClose,
  requireOrganizer,
  onSuccessEmail,
}: Props) {
  const { sendOtp, verifyOtp, changePasswordForReset, signInWithGoogle } = useAuth()
  const [step, setStep] = useState<Step>("email")
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [showGoogle, setShowGoogle] = useState(false)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [resendLockUntil, setResendLockUntil] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [token, setToken] = useState<string | null>(null)
  const activeRef = useRef(false)

  useEffect(() => {
    activeRef.current = open
  }, [open])

  useEffect(() => {
    if (step !== "otp" || !expiresAt) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [step, expiresAt])

  const doSend = async () => {
    if (busy) return
    const trimmed = email.trim()
    if (!trimmed) {
      setError("Please enter your email address.")
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Please enter a valid email address.")
      return
    }
    setBusy(true)
    setError(null)
    setInfo(null)
    const res = await sendOtp(trimmed, { requireOrganizer: requireOrganizer === true })
    if (!activeRef.current) return
    setBusy(false)
    if (res.sent) {
      setShowGoogle(false)
      setCode("")
      setStep("otp")
      setExpiresAt(Date.now() + TTL_MS)
      setResendLockUntil(Date.now() + RESEND_MS)
      setNow(Date.now())
    } else {
      setShowGoogle(true)
      if (res.unified) {
        setInfo(res.message ?? DEFAULT_MESSAGE)
        setError(null)
      } else {
        setError(res.message ?? "Something went wrong. Try again.")
        setInfo(null)
      }
    }
  }

  const doVerify = async () => {
    if (busy) return
    const trimmedCode = code.trim()
    if (!/^\d{6}$/.test(trimmedCode)) {
      setError("Please enter the 6-digit code from the email.")
      return
    }
    setBusy(true)
    setError(null)
    const res = await verifyOtp(email.trim(), trimmedCode)
    if (!activeRef.current) return
    setBusy(false)
    if (res.token) {
      setToken(res.token)
      setError(null)
      setStep("password")
    } else {
      setError(res.error ?? "Invalid or expired code. Try again.")
    }
  }

  const doChange = async () => {
    if (busy) return
    if (!password) {
      setError("Please enter a new password.")
      return
    }
    if (!confirm) {
      setError("Please confirm your password.")
      return
    }
    if (password !== confirm) {
      setError("Passwords do not match.")
      return
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.")
      return
    }
    if (!/[A-Z]/.test(password)) {
      setError("Password needs at least one capital letter.")
      return
    }
    if (!token) {
      setError("This reset session has expired. Please start again.")
      return
    }
    setBusy(true)
    setError(null)
    const res = await changePasswordForReset(token, password)
    if (!activeRef.current) return
    setBusy(false)
    if (res.ok) {
      setSuccess(true)
      window.setTimeout(() => {
        if (!activeRef.current) return
        onSuccessEmail?.(email.trim())
        onClose()
      }, 1400)
    } else {
      setError(res.error ?? "Could not update your password. Try again.")
    }
  }

  const doGoogle = () => {
    onClose()
    signInWithGoogle()
  }

  if (!open) return null

  const resendSeconds = resendLockUntil ? Math.max(0, Math.ceil((resendLockUntil - now) / 1000)) : 0
  const expirySeconds = expiresAt ? Math.max(0, Math.floor((expiresAt - now) / 1000)) : 0
  const expired = expiresAt !== null && expirySeconds <= 0
  const canResend = resendLockUntil === null || resendSeconds <= 0

  const titles: Record<Step, string> = {
    email: "Reset Password",
    otp: "Enter the code",
    password: "Set New Password",
  }
  const subtitles: Record<Step, string> = {
    email: "Enter your email and we'll send you a 6-digit code.",
    otp: `We sent a code to ${email.trim()}. It expires in 10 minutes.`,
    password: "Enter your new password below.",
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Reset password"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold text-neutral-900">{titles[step]}</h2>
            <p className="mt-1 text-sm text-neutral-500">{subtitles[step]}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded-lg p-1 text-neutral-400 transition hover:text-neutral-600 disabled:opacity-50"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="mt-6">
          {success ? (
            <div className="flex flex-col items-center text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="mt-4 text-sm font-medium text-neutral-900">
                Password updated — sign in with your new password.
              </p>
            </div>
          ) : step === "email" ? (
            <div className="space-y-4">
              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
              )}
              {info && (
                <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600">{info}</div>
              )}
              <div>
                <label className={labelCls}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    if (error) setError(null)
                  }}
                  className={inputCls}
                  placeholder="you@example.com"
                  autoFocus
                />
              </div>
              <button
                type="button"
                onClick={doSend}
                disabled={busy || !email.trim()}
                className="w-full rounded-lg bg-cluvo-primary px-4 py-2.5 text-sm font-medium text-white transition hover:bg-cluvo-primary-dark disabled:opacity-50"
              >
                {busy ? "Sending..." : "Send OTP"}
              </button>
              {showGoogle && (
                <button
                  type="button"
                  onClick={doGoogle}
                  disabled={busy}
                  className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50"
                >
                  Continue with Google
                </button>
              )}
            </div>
          ) : step === "otp" ? (
            <div className="space-y-4">
              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
              )}
              <div>
                <label className={labelCls}>6-digit code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    if (error) setError(null)
                  }}
                  className={inputCls}
                  placeholder="123456"
                  autoFocus
                />
              </div>
              <p className={`text-xs ${expired ? "text-red-600" : "text-neutral-400"}`}>
                {expired ? "Code expired — request a new one." : `Code expires in ${mmss(expirySeconds * 1000)}`}
              </p>
              <button
                type="button"
                onClick={doVerify}
                disabled={busy || code.length !== 6 || expired}
                className="w-full rounded-lg bg-cluvo-primary px-4 py-2.5 text-sm font-medium text-white transition hover:bg-cluvo-primary-dark disabled:opacity-50"
              >
                {busy ? "Verifying..." : "Verify Code"}
              </button>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={doSend}
                  disabled={busy || !canResend}
                  className={`text-sm transition disabled:cursor-not-allowed ${
                    canResend ? "text-cluvo-primary hover:underline" : "text-neutral-400"
                  }`}
                >
                  {canResend ? "Resend OTP" : `Resend in ${resendSeconds}s`}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStep("email")
                    setExpiresAt(null)
                    setResendLockUntil(null)
                    setError(null)
                    setInfo(null)
                    setShowGoogle(false)
                  }}
                  disabled={busy}
                  className="text-sm text-neutral-400 transition hover:text-neutral-600 disabled:opacity-50"
                >
                  Use a different email
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
              )}
              <div>
                <label className={labelCls}>New Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value)
                      if (error) setError(null)
                    }}
                    className={`${inputCls} pr-10`}
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
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
              <div>
                <label className={labelCls}>Confirm Password</label>
                <input
                  type={showPassword ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => {
                    setConfirm(e.target.value)
                    if (error) setError(null)
                  }}
                  className={inputCls}
                />
              </div>
              <button
                type="button"
                onClick={doChange}
                disabled={busy || !password || !confirm}
                className="w-full rounded-lg bg-cluvo-primary px-4 py-2.5 text-sm font-medium text-white transition hover:bg-cluvo-primary-dark disabled:opacity-50"
              >
                {busy ? "Updating..." : "Update Password"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}