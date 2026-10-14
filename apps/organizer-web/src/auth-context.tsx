import { createContext, useContext, useEffect, useReducer, useCallback, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { supabase } from "./supabase"
import type { Session, User } from "@supabase/supabase-js"
import { CONSENT_VERSION } from "./legal/consent-version"

interface AuthState {
  user: User | null
  session: Session | null
  loading: boolean
  error: string | null
  success: string | null
  isRecovery: boolean
}

type Action =
  | { type: "SET_USER"; user: User | null; session: Session | null }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "SET_SUCCESS"; success: string | null }
  | { type: "SET_RECOVERY"; isRecovery: boolean }
  | { type: "CLEAR_MESSAGES" }

function reducer(state: AuthState, action: Action): AuthState {
  switch (action.type) {
    case "SET_USER":
      return { ...state, user: action.user, session: action.session, loading: false }
    case "SET_LOADING":
      return { ...state, loading: action.loading }
    case "SET_ERROR":
      return { ...state, error: action.error }
    case "SET_SUCCESS":
      return { ...state, success: action.success }
    case "SET_RECOVERY":
      return { ...state, isRecovery: action.isRecovery }
    case "CLEAR_MESSAGES":
      return { ...state, error: null, success: null }
    default:
      return state
  }
}

interface CheckAccountResult {
  next?: "password" | "google" | "signup"
  message?: string
  error?: string
  networkError?: boolean
}

interface AuthContextType extends AuthState {
  signIn: (email: string, password: string) => Promise<void>
  checkAccount: (email: string) => Promise<CheckAccountResult>
  signInWithPassword: (email: string, password: string) => Promise<{ error?: string }>
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
  blockSession: (message: string) => Promise<void>
  sendOtp: (email: string, opts?: { requireOrganizer?: boolean }) => Promise<{ sent: boolean; message?: string; unified: boolean }>
  verifyOtp: (email: string, code: string) => Promise<{ token?: string; error?: string }>
  changePasswordForReset: (token: string, password: string) => Promise<{ ok: boolean; error?: string }>
  resetPassword: (password: string, onSuccess?: () => void) => Promise<void>
  checkUsername: (username: string) => Promise<boolean>
  checkCommunityName: (name: string) => Promise<boolean>
  recordConsent: (source: "web") => Promise<boolean>
  clearMessages: () => void
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    user: null,
    session: null,
    loading: true,
    error: null,
    success: null,
    isRecovery: false,
  })
  const navigate = useNavigate()

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) {
        dispatch({ type: "SET_USER", user: null, session: null })
        return
      }
      const { data: { session } } = await supabase.auth.getSession()
      dispatch({ type: "SET_USER", user, session })
    }).catch(() => {
      dispatch({ type: "SET_USER", user: null, session: null })
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      try {
        dispatch({ type: "SET_USER", user: session?.user ?? null, session })
        if (event === "PASSWORD_RECOVERY") {
          dispatch({ type: "SET_RECOVERY", isRecovery: true })
          navigate("/reset-password")
        }
      } catch (_) {
        // Auth state change handler failed — state may be stale
      }
    })

    return () => subscription.unsubscribe()
  }, [navigate])

  const signIn = async (email: string, password: string) => {
    if (state.loading) return
    dispatch({ type: "CLEAR_MESSAGES" })
    dispatch({ type: "SET_LOADING", loading: true })
    try {
      // Login goes through the server-side organizer gate: the edge fn checks
      // community ownership and only returns a session for organizers.
      const { supabaseFetchNoAuth } = await import("./supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/login", {
        email: email.trim(),
        password,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg =
          typeof data.error === "string" && data.error.includes("Invalid login credentials")
            ? "Invalid email or password. Please try again."
            : typeof data.error === "string"
              ? data.error
              : "Something went wrong. Please try again."
        dispatch({ type: "SET_ERROR", error: msg })
        return
      }
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      })
      if (sessionError) {
        dispatch({ type: "SET_ERROR", error: "Could not start your session. Please try again." })
        return
      }
      navigate("/dashboard")
    } catch {
      dispatch({ type: "SET_ERROR", error: "Connection error. Check your internet and try again." })
    } finally {
      dispatch({ type: "SET_LOADING", loading: false })
    }
  }

  const checkAccount = useCallback(async (email: string): Promise<CheckAccountResult> => {
    try {
      const { supabaseFetchNoAuth } = await import("./supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/check-account", { email: email.trim() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        return {
          error:
            typeof data.error === "string" && data.error
              ? data.error
              : "Something went wrong. Please try again.",
        }
      }
      const next = data.next
      if (next !== "password" && next !== "google" && next !== "signup") {
        return { error: "Something went wrong. Please try again." }
      }
      return {
        next,
        message: typeof data.message === "string" ? data.message : undefined,
      }
    } catch {
      // Never guess a route on a network failure — the caller offers a retry.
      return { error: "Connection error. Check your internet and try again.", networkError: true }
    }
  }, [])

  // Password sign-in goes straight to GoTrue. The organizer gate is NOT applied
  // here: it is a UX routing decision, not a security boundary (anyone can mint
  // a session via GoTrue with the public anon key). Authoritative access is
  // enforced by RLS and server functions after sign-in. On success we do not
  // navigate — the landing screen routes by role from the new session.
  const signInWithPassword = async (email: string, password: string): Promise<{ error?: string }> => {
    dispatch({ type: "CLEAR_MESSAGES" })
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      if (error) {
        // Neutral copy: banned / disabled / wrong-password all look the same.
        const invalid = /invalid login|invalid.*credentials/i.test(error.message)
        return {
          error: invalid
            ? "Incorrect email or password. Try again, or use the Forgot password link."
            : "Could not sign you in. Please try again.",
        }
      }
      return {}
    } catch {
      return { error: "Connection error. Check your internet and try again." }
    }
  }

  const signInWithGoogle = async () => {
    dispatch({ type: "CLEAR_MESSAGES" })
    dispatch({ type: "SET_LOADING", loading: true })
    try {
      // OAuth never signs out an existing session, so a previous (organizer)
      // session could survive the round-trip and briefly mis-route the landing
      // decision. Clear only THIS browser's session first — scope "local"
      // keeps the user signed in on their other devices. Best-effort: a failure
      // here must not block the OAuth attempt.
      try {
        await supabase.auth.signOut({ scope: "local" })
      } catch {
        // No session to clear, or storage already empty — safe to continue.
      }
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/?oauth=1` },
      })
      if (error) {
        // signInWithOAuth normally navigates away via window.location.assign;
        // if it returns an error it did not redirect, so recover immediately.
        dispatch({ type: "SET_ERROR", error: "Google sign-in failed. Try again." })
        dispatch({ type: "SET_LOADING", loading: false })
        return
      }
      // Redirect is in flight — reset loading if the user cancels the Google
      // window so the button is not stuck disabled.
      setTimeout(() => dispatch({ type: "SET_LOADING", loading: false }), 20000)
    } catch {
      dispatch({ type: "SET_ERROR", error: "Google sign-in failed. Try again." })
      dispatch({ type: "SET_LOADING", loading: false })
    }
  }

  const signOut = async () => {
    if (state.loading) return
    dispatch({ type: "CLEAR_MESSAGES" })
    dispatch({ type: "SET_LOADING", loading: true })
    try {
      await Promise.race([
        supabase.auth.signOut(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000)),
      ])
    } catch {
      // still navigate even if timeout / error
    } finally {
      dispatch({ type: "SET_LOADING", loading: false })
      navigate("/")
    }
  }

  const blockSession = useCallback(async (message: string) => {
    try {
      await supabase.auth.signOut()
    } catch {
      // best effort — supabase-js clears the local session regardless
    }
    dispatch({ type: "SET_ERROR", error: message })
  }, [])

  const sendOtp = async (
    email: string,
    opts?: { requireOrganizer?: boolean },
  ): Promise<{ sent: boolean; message?: string; unified: boolean }> => {
    try {
      const { supabaseFetchNoAuth } = await import("./supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/forgot-password", {
        email: email.trim(),
        requireOrganizer: opts?.requireOrganizer === true,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          typeof data.error === "string" && data.error
            ? data.error
            : "Something went wrong. Try again."
        return { sent: false, message, unified: false }
      }
      if (data.sent === true) return { sent: true, unified: false }
      // sent:false on a 200 = the deliberate no-enumeration copy (neutral info,
      // not an error).
      return {
        sent: false,
        message:
          typeof data.message === "string" && data.message
            ? data.message
            : "If your email uses password login, a code has been sent. If it uses Google, please sign in with Google instead.",
        unified: true,
      }
    } catch {
      return { sent: false, message: "Connection error. Check your internet and try again.", unified: false }
    }
  }

  const verifyOtp = async (email: string, code: string): Promise<{ token?: string; error?: string }> => {
    try {
      const { supabaseFetchNoAuth } = await import("./supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/verify-otp", {
        email: email.trim(),
        code: code.trim(),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        return {
          error:
            typeof data.error === "string" && data.error
              ? data.error
              : "Invalid or expired code. Try again.",
        }
      }
      const token = typeof data.token === "string" && data.token ? data.token : undefined
      return token ? { token } : { error: "Invalid or expired code. Try again." }
    } catch {
      return { error: "Connection error. Check your internet and try again." }
    }
  }

  const changePasswordForReset = async (token: string, password: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const { supabaseFetchNoAuth } = await import("./supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/change-password", {
        token,
        password,
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok === true) return { ok: true }
      return {
        ok: false,
        error:
          typeof data.error === "string" && data.error
            ? data.error
            : "Could not update your password. Try again.",
      }
    } catch {
      return { ok: false, error: "Connection error. Check your internet and try again." }
    }
  }

  const resetPassword = async (password: string, onSuccess?: () => void) => {
    dispatch({ type: "CLEAR_MESSAGES" })
    dispatch({ type: "SET_LOADING", loading: true })
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) {
        dispatch({ type: "SET_ERROR", error: error.message })
        return
      }
      // End the temporary recovery session BEFORE showing success so the router
      // returns to the login card instead of bouncing the user to /dashboard.
      try {
        await supabase.auth.signOut()
      } catch {
        // best effort — supabase-js clears the local session regardless
      }
      dispatch({ type: "SET_RECOVERY", isRecovery: false })
      dispatch({ type: "SET_SUCCESS", success: "Password updated — sign in with your new password." })
      setTimeout(() => { onSuccess?.(); navigate("/") }, 500)
    } catch {
      dispatch({ type: "SET_ERROR", error: "Connection error. Check your internet and try again." })
    } finally {
      dispatch({ type: "SET_LOADING", loading: false })
    }
  }

  const checkUsername = useCallback(async (username: string): Promise<boolean> => {
    try {
      const { supabaseFetchNoAuth } = await import("./supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/check-username", { username })
      const data = await res.json()
      return data.available === true
    } catch {
      return true
    }
  }, [])

  const checkCommunityName = useCallback(async (name: string): Promise<boolean> => {
    try {
      const { supabaseFetchNoAuth } = await import("./supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/check-community-name", { name })
      const data = await res.json()
      return data.available === true
    } catch {
      return true
    }
  }, [])

  const clearMessages = useCallback(() => dispatch({ type: "CLEAR_MESSAGES" }), [])

  const recordConsent = useCallback(async (source: "web"): Promise<boolean> => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return false
    try {
      const { supabaseFetch } = await import("./supabase-fetch")
      const res = await supabaseFetch("/functions/v1/record-consent", session.access_token, {
        consent_version: CONSENT_VERSION,
        source,
      })
      return res.ok
    } catch {
      return false
    }
  }, [])

  return (
    <AuthContext.Provider
      value={{
        ...state,
        signIn,
        checkAccount,
        signInWithPassword,
        signInWithGoogle,
        signOut,
        blockSession,
        sendOtp,
        verifyOtp,
        changePasswordForReset,
        resetPassword,
        checkUsername,
        checkCommunityName,
        recordConsent,
        clearMessages,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
