import { useState } from "react"
import { Link } from "react-router-dom"
import { useAuth } from "../Auth"

export default function ForgotPasswordPage() {
  const { sendResetLink, loading, error, success } = useAuth()
  const [email, setEmail] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    await sendResetLink(email.trim())
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#C2185B] px-4">
      <div className="w-full max-w-md animate-slide-in-right">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-wider text-white">CLUVO</h1>
          <p className="mt-2 text-sm text-white/80">Admin Portal</p>
        </div>
        <form onSubmit={handleSubmit} className="rounded-2xl bg-white p-8 shadow-strong">
          <h2 className="text-xl font-semibold text-neutral-900">Reset Password</h2>
          <p className="mt-1 text-sm text-neutral-500">Enter your email to receive a reset link.</p>

          {error && (
            <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
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
                Back to Sign In
              </Link>
            </div>
          ) : (
            <>
              <div className="mt-6">
                <label className="text-sm font-medium text-neutral-700">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="mt-1.5 block w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 placeholder-neutral-400 focus:border-[#C2185B] focus:outline-none focus:ring-1 focus:ring-[#C2185B]"
                />
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
                Send Reset Link
              </button>

              <p className="mt-4 text-center text-sm text-neutral-500">
                <Link to="/" className="font-medium text-[#C2185B] hover:text-[#A0174A]">Back to Sign In</Link>
              </p>
            </>
          )}
        </form>
      </div>
    </div>
  )
}
