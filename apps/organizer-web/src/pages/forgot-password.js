import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth-context";
export default function ForgotPasswordPage() {
    const { sendResetLink, loading, error, success, clearMessages } = useAuth();
    const [email, setEmail] = useState("");
    const navigate = useNavigate();
    const handleSubmit = (e) => {
        e.preventDefault();
        clearMessages();
        if (!email.trim())
            return;
        sendResetLink(email);
    };
    if (success) {
        return (_jsx("div", { className: "flex min-h-screen items-center justify-center bg-neutral-50 px-4", children: _jsxs("div", { className: "w-full max-w-sm text-center", children: [_jsx("div", { className: "mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100", children: _jsx("svg", { className: "h-6 w-6 text-green-600", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 2, d: "M5 13l4 4L19 7" }) }) }), _jsx("h1", { className: "text-xl font-semibold text-neutral-900", children: "Check your email" }), _jsxs("p", { className: "mt-2 text-sm text-neutral-500", children: ["We've sent a magic link to ", _jsx("strong", { children: email }), ". Click it to reset your password."] }), _jsx("button", { onClick: () => navigate("/"), className: "mt-6 text-sm text-[#C2185B] hover:underline", children: "Back to Sign In" })] }) }));
    }
    return (_jsx("div", { className: "flex min-h-screen items-center justify-center bg-neutral-50 px-4", children: _jsxs("div", { className: "w-full max-w-sm", children: [_jsxs("div", { className: "mb-8", children: [_jsx("button", { onClick: () => navigate("/"), className: "text-sm text-[#C2185B] hover:underline", children: "\u2190 Back" }), _jsx("h1", { className: "mt-4 text-2xl font-semibold text-neutral-900", children: "Reset Password" }), _jsx("p", { className: "mt-1 text-sm text-neutral-500", children: "Enter your email and we'll send you a magic link to reset your password." })] }), _jsxs("form", { onSubmit: handleSubmit, className: "space-y-4", children: [error && (_jsx("div", { className: "rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600", children: error })), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-sm font-medium text-neutral-700", children: "Email" }), _jsx("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), className: "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20", placeholder: "Enter your email" })] }), _jsx("button", { type: "submit", disabled: loading || !email.trim(), className: "w-full rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50", children: loading ? "Sending..." : "Send Magic Link" })] })] }) }));
}
//# sourceMappingURL=forgot-password.js.map