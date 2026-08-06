import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useAuth } from "../auth-context"

export default function ForgotPasswordPage() {
  const {
    sendResetLink,
    signInWithGoogle,
    loading,
    error,
    success,
    googleOnly,
    clearMessages,
  } = useAuth()
  const [email, setEmail] = useState("")
  const navigate = useNavigate()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    clearMessages()
    if (!email.trim()) return
    sendResetLink(email)
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
        <div className="w-full max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
            <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-neutral-900">Check your email</h1>
          <p className="mt-2 text-sm text-neutral-500">
            We've sent a reset link to <strong>{email}</strong>. Click it to reset your password.
          </p>
          <button onClick={() => navigate("/")} className="mt-6 text-sm text-[#C2185B] hover:underline">
            Back to Sign In
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <button onClick={() => navigate("/")} className="text-sm text-[#C2185B] hover:underline">&larr; Back</button>
          <h1 className="mt-4 text-2xl font-semibold text-neutral-900">Reset Password</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Enter your email and we'll send you a link to reset your password.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
              {error}
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-sm font-medium text-neutral-700">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                if (googleOnly) clearMessages()
              }}
              className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
              placeholder="Enter your email"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !email.trim()}
            className="w-full rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50"
          >
            {loading ? "Sending..." : "Send Reset Link"}
          </button>

          {googleOnly && (
            <button
              type="button"
              onClick={() => signInWithGoogle()}
              disabled={loading}
              className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50"
            >
              {loading ? "Connecting..." : "Continue with Google"}
            </button>
          )}
        </form>
      </div>
    </div>
  )
}