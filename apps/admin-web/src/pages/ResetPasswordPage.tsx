import { useState, useEffect } from "react"
import { Link, useNavigate } from "react-router-dom"
import { supabase } from "../supabase"
import { useAuth } from "../Auth"

export default function ResetPasswordPage() {
  const { resetPassword, loading, error, success } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [localError, setLocalError] = useState("")

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/", { replace: true })
    })
  }, [navigate])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError("")
    if (password.length < 8) {
      setLocalError("Password must be at least 8 characters.")
      return
    }
    if (!/[A-Z]/.test(password)) {
      setLocalError("Password must contain at least one capital letter.")
      return
    }
    if (password !== confirm) {
      setLocalError("Passwords do not match.")
      return
    }
    await resetPassword(password)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#C2185B] px-4">
      <div className="w-full max-w-md animate-slide-in-right">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-wider text-white">CLUVO</h1>
          <p className="mt-2 text-sm text-white/80">Admin Portal</p>
        </div>
        <form onSubmit={handleSubmit} className="rounded-2xl bg-white p-8 shadow-strong">
          <h2 className="text-xl font-semibold text-neutral-900">Set New Password</h2>
          <p className="mt-1 text-sm text-neutral-500">Choose a new password for your account.</p>

          {(error || localError) && (
            <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error || localError}</div>
          )}

          {success ? (
            <div className="mt-6 space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm text-neutral-600">{success}</p>
              <Link to="/" className="block text-sm font-medium text-[#C2185B] hover:text-[#A0174A]">
                Sign in with new password
              </Link>
            </div>
          ) : (
            <>
              <div className="mt-6 space-y-4">
                <div>
                  <label className="text-sm font-medium text-neutral-700">New Password</label>
                  <div className="relative mt-1.5">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Min. 8 characters, 1 capital"
                      className="block w-full rounded-lg border border-neutral-300 px-3 py-2.5 pr-10 text-sm text-neutral-900 placeholder-neutral-400 focus:border-[#C2185B] focus:outline-none focus:ring-1 focus:ring-[#C2185B]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                    >
                      {showPassword ? (
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" /></svg>
                      ) : (
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                      )}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium text-neutral-700">Confirm Password</label>
                  <div className="relative mt-1.5">
                    <input
                      type={showConfirm ? "text" : "password"}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder="Re-enter your password"
                      className="block w-full rounded-lg border border-neutral-300 px-3 py-2.5 pr-10 text-sm text-neutral-900 placeholder-neutral-400 focus:border-[#C2185B] focus:outline-none focus:ring-1 focus:ring-[#C2185B]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirm(!showConfirm)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                    >
                      {showConfirm ? (
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" /></svg>
                      ) : (
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#A0174A] disabled:opacity-50"
              >
                {loading && (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                Update Password
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  )
}
