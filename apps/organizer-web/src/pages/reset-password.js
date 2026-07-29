import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth-context";
export default function ResetPasswordPage() {
    const { resetPassword, loading, error, clearMessages } = useAuth();
    const navigate = useNavigate();
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const handleSubmit = (e) => {
        e.preventDefault();
        clearMessages();
        if (!password.trim())
            return;
        if (password !== confirm)
            return;
        resetPassword(password, () => navigate("/dashboard"));
    };
    return (_jsx("div", { className: "flex min-h-screen items-center justify-center bg-neutral-50 px-4", children: _jsxs("div", { className: "w-full max-w-sm", children: [_jsxs("div", { className: "mb-8", children: [_jsx("h1", { className: "text-2xl font-semibold text-neutral-900", children: "Set New Password" }), _jsx("p", { className: "mt-1 text-sm text-neutral-500", children: "Enter your new password below." })] }), _jsxs("form", { onSubmit: handleSubmit, className: "space-y-4", children: [error && (_jsx("div", { className: "rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600", children: error })), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-sm font-medium text-neutral-700", children: "New Password" }), _jsxs("div", { className: "relative", children: [_jsx("input", { type: showPassword ? "text" : "password", value: password, onChange: (e) => setPassword(e.target.value), className: "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 pr-10 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" }), _jsx("button", { type: "button", onClick: () => setShowPassword(!showPassword), className: "absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600", children: showPassword ? (_jsxs("svg", { className: "h-4 w-4", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", children: [_jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 2, d: "M15 12a3 3 0 11-6 0 3 3 0 016 0z" }), _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 2, d: "M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" })] })) : (_jsx("svg", { className: "h-4 w-4", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 2, d: "M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" }) })) })] }), _jsx("p", { className: "mt-1 text-xs text-neutral-400", children: "8+ characters, 1 capital letter" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-sm font-medium text-neutral-700", children: "Confirm Password" }), _jsx("input", { type: "password", value: confirm, onChange: (e) => setConfirm(e.target.value), className: "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsx("button", { type: "submit", disabled: loading || !password.trim() || password !== confirm, className: "w-full rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50", children: loading ? "Resetting..." : "Reset Password" })] })] }) }));
}
//# sourceMappingURL=reset-password.js.map