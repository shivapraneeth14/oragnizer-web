import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { supabase } from "../supabase";
export default function DashboardLogin({ onBack }) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        if (!email.trim() || !password.trim())
            return;
        setLoading(true);
        try {
            const { error: err } = await supabase.auth.signInWithPassword({
                email: email.trim(),
                password,
            });
            setLoading(false);
            if (err) {
                const msg = err.message.includes("Invalid login credentials")
                    ? "Invalid email or password. Please try again."
                    : err.message.includes("Email not confirmed")
                        ? "Please confirm your email address."
                        : err.message;
                setError(msg);
                return;
            }
            window.location.href = "/dashboard";
        }
        catch {
            setLoading(false);
            setError("Connection error. Check your internet and try again.");
        }
    };
    return (_jsxs("div", { children: [_jsx("button", { type: "button", onClick: onBack, className: "mb-4 text-sm text-[#C2185B] hover:underline", children: "\u2190 Back" }), _jsx("h2", { className: "text-xl font-semibold text-neutral-900", children: "Sign In" }), _jsx("p", { className: "mt-1 text-sm text-neutral-500", children: "Sign in to go to your dashboard." }), _jsxs("form", { onSubmit: handleSubmit, className: "mt-6 space-y-4", children: [error && (_jsx("div", { className: "rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600", children: error })), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-sm font-medium text-neutral-700", children: "Email" }), _jsx("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), className: "w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20", placeholder: "you@example.com" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-sm font-medium text-neutral-700", children: "Password" }), _jsxs("div", { className: "relative", children: [_jsx("input", { type: showPassword ? "text" : "password", value: password, onChange: (e) => setPassword(e.target.value), className: "w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 pr-10 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" }), _jsx("button", { type: "button", onClick: () => setShowPassword(!showPassword), className: "absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600", children: showPassword ? (_jsx("svg", { className: "h-4 w-4", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" }) })) : (_jsxs("svg", { className: "h-4 w-4", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: [_jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M15 12a3 3 0 11-6 0 3 3 0 016 0z" }), _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" })] })) })] })] }), _jsx("button", { type: "submit", disabled: loading || !email.trim() || !password.trim(), className: "w-full rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50", children: loading ? "Signing in..." : "Sign In" })] })] }));
}
//# sourceMappingURL=dashboard-login.js.map