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
}

type Action =
  | { type: "SET_USER"; user: User | null; session: Session | null }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "SET_SUCCESS"; success: string | null }
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
    case "CLEAR_MESSAGES":
      return { ...state, error: null, success: null }
    default:
      return state
  }
}

interface AuthContextType extends AuthState {
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
  blockSession: (message: string) => Promise<void>
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
    } = supabase.auth.onAuthStateChange((_event, session) => {
      try {
        dispatch({ type: "SET_USER", user: session?.user ?? null, session })
      } catch (_) {
        // Auth state change handler failed — state may be stale
      }
    })

    return () => subscription.unsubscribe()
  }, [navigate])

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
        signInWithGoogle,
        signOut,
        blockSession,
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
