import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useEffect, useReducer, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "./supabase";
function reducer(state, action) {
    switch (action.type) {
        case "SET_USER":
            return { ...state, user: action.user, session: action.session, loading: false };
        case "SET_LOADING":
            return { ...state, loading: action.loading };
        case "SET_ERROR":
            return { ...state, error: action.error };
        case "SET_SUCCESS":
            return { ...state, success: action.success };
        case "SET_RECOVERY":
            return { ...state, isRecovery: action.isRecovery };
        case "SET_OTP_SENT":
            return { ...state, otpSent: action.otpSent };
        case "SET_OTP_VERIFIED":
            return { ...state, otpVerified: action.otpVerified };
        case "CLEAR_MESSAGES":
            return { ...state, error: null, success: null };
        default:
            return state;
    }
}
const AuthContext = createContext(null);
export function AuthProvider({ children }) {
    const [state, dispatch] = useReducer(reducer, {
        user: null,
        session: null,
        loading: true,
        error: null,
        success: null,
        isRecovery: false,
        otpSent: false,
        otpVerified: false,
    });
    const navigate = useNavigate();
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            dispatch({ type: "SET_USER", user: session?.user ?? null, session });
        }).catch(() => {
            dispatch({ type: "SET_USER", user: null, session: null });
        });
        const { data: { subscription }, } = supabase.auth.onAuthStateChange((event, session) => {
            try {
                dispatch({ type: "SET_USER", user: session?.user ?? null, session });
                if (event === "PASSWORD_RECOVERY") {
                    dispatch({ type: "SET_RECOVERY", isRecovery: true });
                    navigate("/reset-password");
                }
            }
            catch (_) {
                // Auth state change handler failed — state may be stale
            }
        });
        return () => subscription.unsubscribe();
    }, [navigate]);
    const signIn = async (email, password) => {
        if (state.loading)
            return;
        dispatch({ type: "CLEAR_MESSAGES" });
        dispatch({ type: "SET_LOADING", loading: true });
        try {
            const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
            if (error) {
                const msg = error.message.includes("Invalid login credentials")
                    ? "Invalid email or password. Please try again."
                    : error.message.includes("Email not confirmed")
                        ? "Please confirm your email address."
                        : error.message;
                dispatch({ type: "SET_ERROR", error: msg });
                return;
            }
            navigate("/dashboard");
        }
        catch {
            dispatch({ type: "SET_ERROR", error: "Connection error. Check your internet and try again." });
        }
        finally {
            dispatch({ type: "SET_LOADING", loading: false });
        }
    };
    const signInWithGoogle = async () => {
        if (state.loading)
            return;
        dispatch({ type: "CLEAR_MESSAGES" });
        dispatch({ type: "SET_LOADING", loading: true });
        try {
            await supabase.auth.signInWithOAuth({
                provider: "google",
                options: { redirectTo: `${window.location.origin}/dashboard` },
            });
            // OAuth redirects away — loading persists until page reloads
        }
        catch {
            dispatch({ type: "SET_ERROR", error: "Google sign-in failed. Try again." });
            dispatch({ type: "SET_LOADING", loading: false });
        }
    };
    const signOut = async () => {
        if (state.loading)
            return;
        dispatch({ type: "CLEAR_MESSAGES" });
        dispatch({ type: "SET_LOADING", loading: true });
        try {
            await Promise.race([
                supabase.auth.signOut(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000)),
            ]);
        }
        catch {
            // still navigate even if timeout / error
        }
        finally {
            dispatch({ type: "SET_LOADING", loading: false });
            navigate("/");
        }
    };
    const sendResetLink = async (email) => {
        if (state.loading)
            return;
        dispatch({ type: "CLEAR_MESSAGES" });
        dispatch({ type: "SET_LOADING", loading: true });
        try {
            const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
                redirectTo: `${window.location.origin}/reset-password`,
            });
            if (error) {
                dispatch({ type: "SET_ERROR", error: error.message });
                return;
            }
            dispatch({ type: "SET_SUCCESS", success: "Check your email for the reset link." });
        }
        catch {
            dispatch({ type: "SET_ERROR", error: "Connection error. Check your internet and try again." });
        }
        finally {
            dispatch({ type: "SET_LOADING", loading: false });
        }
    };
    const resetPassword = async (password, onSuccess) => {
        dispatch({ type: "CLEAR_MESSAGES" });
        dispatch({ type: "SET_LOADING", loading: true });
        try {
            const { error } = await supabase.auth.updateUser({ password });
            if (error) {
                dispatch({ type: "SET_ERROR", error: error.message });
                return;
            }
            dispatch({ type: "SET_RECOVERY", isRecovery: false });
            dispatch({ type: "SET_SUCCESS", success: "Password updated successfully!" });
            setTimeout(() => { onSuccess?.(); navigate("/dashboard"); }, 1500);
        }
        catch {
            dispatch({ type: "SET_ERROR", error: "Connection error. Check your internet and try again." });
        }
        finally {
            dispatch({ type: "SET_LOADING", loading: false });
        }
    };
    const checkUsername = useCallback(async (username) => {
        try {
            const { supabaseFetchNoAuth } = await import("./supabase-fetch");
            const res = await supabaseFetchNoAuth("/functions/v1/check-username", { username });
            const data = await res.json();
            return data.available === true;
        }
        catch {
            return true;
        }
    }, []);
    const checkCommunityName = useCallback(async (name) => {
        try {
            const { supabaseFetchNoAuth } = await import("./supabase-fetch");
            const res = await supabaseFetchNoAuth("/functions/v1/check-community-name", { name });
            const data = await res.json();
            return data.available === true;
        }
        catch {
            return true;
        }
    }, []);
    const clearMessages = useCallback(() => dispatch({ type: "CLEAR_MESSAGES" }), []);
    return (_jsx(AuthContext.Provider, { value: {
            ...state,
            signIn,
            signInWithGoogle,
            signOut,
            sendResetLink,
            resetPassword,
            checkUsername,
            checkCommunityName,
            clearMessages,
        }, children: children }));
}
export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx)
        throw new Error("useAuth must be used within AuthProvider");
    return ctx;
}
//# sourceMappingURL=auth-context.js.map