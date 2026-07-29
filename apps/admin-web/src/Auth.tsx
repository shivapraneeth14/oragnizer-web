import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { supabase } from "./supabase"
import type { Session, User } from "@supabase/supabase-js"

interface AuthState {
  user: User | null
  session: Session | null
  loading: boolean
  isAdmin: boolean
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
  | { type: "SET_ADMIN"; isAdmin: boolean }
  | { type: "CLEAR_MESSAGES" }

function reducer(state: AuthState, action: Action): AuthState {
  switch (action.type) {
    case "SET_USER":
      return { ...state, user: action.user, session: action.session }
    case "SET_LOADING":
      return { ...state, loading: action.loading }
    case "SET_ERROR":
      return { ...state, error: action.error, success: null }
    case "SET_SUCCESS":
      return { ...state, success: action.success, error: null }
    case "SET_RECOVERY":
      return { ...state, isRecovery: action.isRecovery }
    case "SET_ADMIN":
      return { ...state, isAdmin: action.isAdmin }
    case "CLEAR_MESSAGES":
      return { ...state, error: null, success: null }
    default:
      return state
  }
}

const initialState: AuthState = {
  user: null,
  session: null,
  loading: true,
  isAdmin: false,
  error: null,
  success: null,
  isRecovery: false,
}

interface AuthContextValue extends AuthState {
  signIn: (email: string, password: string) => Promise<void>
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
  sendResetLink: (email: string) => Promise<void>
  resetPassword: (password: string) => Promise<void>
  clearMessages: () => void
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const navigate = useNavigate()

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session) {
        dispatch({ type: "SET_USER", user: session.user, session })
        await checkAdmin(session.user.id)
      }
      dispatch({ type: "SET_LOADING", loading: false })
    }).catch(() => {
      dispatch({ type: "SET_LOADING", loading: false })
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      try {
        dispatch({ type: "SET_USER", user: session?.user ?? null, session })
        if (event === "PASSWORD_RECOVERY") {
          dispatch({ type: "SET_RECOVERY", isRecovery: true })
          navigate("/reset-password")
          return
        }
        if (session) {
          checkAdmin(session.user.id).then(() => {
            dispatch({ type: "SET_LOADING", loading: false })
          })
        } else {
          dispatch({ type: "SET_ADMIN", isAdmin: false })
          dispatch({ type: "SET_LOADING", loading: false })
        }
      } catch (_) {
        dispatch({ type: "SET_LOADING", loading: false })
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function checkAdmin(userId: string) {
    try {
      const { data } = await supabase
        .from("profiles")
        .select("is_admin")
        .eq("id", userId)
        .single()
      dispatch({ type: "SET_ADMIN", isAdmin: data?.is_admin ?? false })
    } catch (_) {
      dispatch({ type: "SET_ADMIN", isAdmin: false })
    }
  }

  const signIn = async (email: string, password: string) => {
    dispatch({ type: "SET_LOADING", loading: true })
    dispatch({ type: "CLEAR_MESSAGES" })
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      dispatch({ type: "SET_LOADING", loading: false })
      if (error) {
      const msg = error.message.includes("Invalid login credentials")
        ? "Invalid email or password. Please try again."
        : error.message
      dispatch({ type: "SET_ERROR", error: msg })
      return
    }
    if (data.session) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("is_admin")
        .eq("id", data.session.user.id)
        .single()
      if (!profile?.is_admin) {
        await supabase.auth.signOut()
        dispatch({ type: "SET_ADMIN", isAdmin: false })
        dispatch({ type: "SET_ERROR", error: "Access denied. This portal is for administrators only." })
        return
      }
      dispatch({ type: "SET_ADMIN", isAdmin: true })
    }
    } catch (_) {
      dispatch({ type: "SET_LOADING", loading: false })
      dispatch({ type: "SET_ERROR", error: "Connection error. Try again." })
    }
  }

  const signInWithGoogle = async () => {
    try {
      await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/dashboard` },
      })
    } catch {
      dispatch({ type: "SET_ERROR", error: "Google sign-in failed. Try again." })
    }
  }

  const signOut = async () => {
    dispatch({ type: "CLEAR_MESSAGES" })
    await Promise.race([
      supabase.auth.signOut(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000)),
    ]).catch(() => {
      supabase.auth.stopAutoRefresh()
    })
    dispatch({ type: "SET_USER", user: null, session: null })
    dispatch({ type: "SET_ADMIN", isAdmin: false })
  }

  const sendResetLink = async (email: string) => {
    dispatch({ type: "SET_LOADING", loading: true })
    dispatch({ type: "CLEAR_MESSAGES" })
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      dispatch({ type: "SET_LOADING", loading: false })
      if (error) {
        dispatch({ type: "SET_ERROR", error: error.message })
        return
      }
      dispatch({ type: "SET_SUCCESS", success: "Check your email for a reset link." })
    } catch (_) {
      dispatch({ type: "SET_LOADING", loading: false })
      dispatch({ type: "SET_ERROR", error: "Connection error. Try again." })
    }
  }

  const resetPassword = async (password: string) => {
    dispatch({ type: "SET_LOADING", loading: true })
    dispatch({ type: "CLEAR_MESSAGES" })
    try {
      const { error } = await supabase.auth.updateUser({ password })
      dispatch({ type: "SET_LOADING", loading: false })
      if (error) {
        dispatch({ type: "SET_ERROR", error: error.message })
        return
      }
      dispatch({ type: "SET_RECOVERY", isRecovery: false })
      dispatch({ type: "SET_SUCCESS", success: "Password updated. Sign in with your new password." })
    } catch (_) {
      dispatch({ type: "SET_LOADING", loading: false })
      dispatch({ type: "SET_ERROR", error: "Connection error. Try again." })
    }
  }

  const clearMessages = () => dispatch({ type: "CLEAR_MESSAGES" })

  return (
    <AuthContext.Provider value={{ ...state, signIn, signInWithGoogle, signOut, sendResetLink, resetPassword, clearMessages }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
