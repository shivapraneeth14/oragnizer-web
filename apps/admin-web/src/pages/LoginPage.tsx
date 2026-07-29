import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useAuth } from "../Auth"

export default function LoginPage() {
  const { signIn, signInWithGoogle, error, loading, clearMessages, session, isAdmin } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState("")

  if (session && isAdmin) {
    navigate("/dashboard", { replace: true })
    return null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError("")
    if (!email.trim() || !password.trim()) return
    setSubmitting(true)
    clearMessages()
    await signIn(email.trim(), password)
    setSubmitting(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#C2185B] px-4">
      <div className="w-full max-w-md animate-slide-in-right">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-wider text-white">CLUVO</h1>
          <p className="mt-2 text-sm text-white/80">Admin Portal</p>
        </div>
        <form onSubmit={handleSubmit} className="rounded-2xl bg-white p-8 shadow-strong">
          <h2 className="text-xl font-semibold text-neutral-900">Sign In</h2>
          <p className="mt-1 text-sm text-neutral-500">Access the platform admin dashboard.</p>

          {(error || localError) && (
            <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">
              {error || localError}
            </div>
          )}

          <div className="mt-6 space-y-4">
            <div>
              <label className="text-sm font-medium text-neutral-700">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1.5 block w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 placeholder-neutral-400 focus:border-[#C2185B] focus:outline-none focus:ring-1 focus:ring-[#C2185B]"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-neutral-700">Password</label>
              <div className="relative mt-1.5">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="block w-full rounded-lg border border-neutral-300 px-3 py-2.5 pr-10 text-sm text-neutral-900 placeholder-neutral-400 focus:border-[#C2185B] focus:outline-none focus:ring-1 focus:ring-[#C2185B]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                >
                  {showPassword ? (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
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
          </div>

          <div className="mt-2 text-right">
            <Link to="/forgot-password" className="text-xs text-neutral-500 hover:text-[#C2185B]">
              Forgot password?
            </Link>
          </div>

          <button
            type="submit"
            disabled={submitting || loading}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#A0174A] disabled:opacity-50"
          >
            {submitting || loading ? (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : null}
            {submitting ? "Signing in..." : "Sign In"}
          </button>

          <div className="relative my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-neutral-200" />
            <span className="text-xs text-neutral-400">or</span>
            <div className="h-px flex-1 bg-neutral-200" />
          </div>

          <button
            type="button"
            onClick={signInWithGoogle}
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-neutral-300 px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 transition-colors"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>
        </form>
      </div>
    </div>
  )
}
