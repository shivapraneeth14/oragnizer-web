import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useCallback, useRef, useEffect } from "react";
import { supabase } from "../supabase";
import CommunityDetailsForm, { initialCommunityData } from "./community-details-form";
export default function NewUserFlow({ onBack }) {
    const [step, setStep] = useState("register");
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [username, setUsername] = useState("");
    const [usernameAvailable, setUsernameAvailable] = useState(null);
    const [checkingUsername, setCheckingUsername] = useState(false);
    const [registerLoading, setRegisterLoading] = useState(false);
    const [registerError, setRegisterError] = useState("");
    const [otp, setOtp] = useState(["", "", "", "", "", ""]);
    const [otpLoading, setOtpLoading] = useState(false);
    const [otpError, setOtpError] = useState("");
    const otpRefs = useRef([]);
    const [communityData, setCommunityData] = useState(initialCommunityData);
    const [communityStep, setCommunityStep] = useState(1);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState("");
    const [accessToken, setAccessToken] = useState(null);
    const usernameTimer = useRef(null);
    useEffect(() => {
        if (usernameTimer.current)
            clearTimeout(usernameTimer.current);
        const u = username.trim();
        if (u.length < 3) {
            setUsernameAvailable(null);
            setCheckingUsername(false);
            return;
        }
        setCheckingUsername(true);
        usernameTimer.current = setTimeout(async () => {
            const { supabaseFetchNoAuth } = await import("../supabase-fetch");
            const res = await supabaseFetchNoAuth("/functions/v1/check-username", { username: u });
            const d = await res.json();
            setUsernameAvailable(d.available === true);
            setCheckingUsername(false);
        }, 500);
        return () => { if (usernameTimer.current)
            clearTimeout(usernameTimer.current); };
    }, [username]);
    const checkCommunityName = useCallback(async (name) => {
        try {
            const { supabaseFetchNoAuth } = await import("../supabase-fetch");
            const res = await supabaseFetchNoAuth("/functions/v1/check-community-name", { name });
            const d = await res.json();
            return d.available === true;
        }
        catch {
            return true;
        }
    }, []);
    const handleRegister = async (e) => {
        e.preventDefault();
        setRegisterError("");
        if (!firstName.trim() || !lastName.trim() || !email.trim() || !password.trim() || !username.trim())
            return;
        if (usernameAvailable === false) {
            setRegisterError("This username is already taken.");
            return;
        }
        setRegisterLoading(true);
        try {
            const { supabaseFetchNoAuth } = await import("../supabase-fetch");
            const res = await supabaseFetchNoAuth("/functions/v1/register", {
                email: email.trim(),
                password,
                first_name: firstName.trim(),
                last_name: lastName.trim(),
                username: username.trim(),
            });
            const result = await res.json();
            if (!res.ok) {
                setRegisterError(result.error || "Something went wrong. Try again.");
                return;
            }
            setStep("otp");
        }
        catch {
            setRegisterError("Connection error. Check your internet and try again.");
        }
        finally {
            setRegisterLoading(false);
        }
    };
    const handleOtpChange = (index, value) => {
        if (!/^\d?$/.test(value))
            return;
        const newOtp = [...otp];
        newOtp[index] = value;
        setOtp(newOtp);
        if (value && index < 5) {
            otpRefs.current[index + 1]?.focus();
        }
    };
    const handleOtpKeyDown = (index, e) => {
        if (e.key === "Backspace" && !otp[index] && index > 0) {
            otpRefs.current[index - 1]?.focus();
        }
    };
    const handleVerify = async () => {
        const code = otp.join("");
        if (code.length < 6)
            return;
        setOtpLoading(true);
        setOtpError("");
        const { data, error } = await supabase.auth.verifyOtp({
            email: email.trim(),
            token: code,
            type: "email",
        });
        setOtpLoading(false);
        if (error) {
            setOtpError(error.message.includes("otp")
                ? "Invalid verification code. Please check and try again."
                : error.message);
            return;
        }
        if (data.session) {
            setAccessToken(data.session.access_token);
            setStep("community");
        }
    };
    const handleCreate = async () => {
        if (!communityData.agree18 || !communityData.agreeContent || !accessToken)
            return;
        setSubmitting(true);
        setSubmitError("");
        try {
            const { supabaseFetch } = await import("../supabase-fetch");
            const res = await supabaseFetch("/functions/v1/create-community", accessToken, communityData);
            const result = await res.json();
            if (!res.ok) {
                setSubmitError(result.error || "Something went wrong. Try again.");
                return;
            }
            window.location.href = "/dashboard";
        }
        catch {
            setSubmitError("Connection error. Check your internet and try again.");
        }
        finally {
            setSubmitting(false);
        }
    };
    const resendOtp = async () => {
        setOtpLoading(true);
        await supabase.auth.signInWithOtp({ email: email.trim() });
        setOtpLoading(false);
        setOtp(["", "", "", "", "", ""]);
    };
    return (_jsxs("div", { children: [step !== "otp" && (_jsx("button", { type: "button", onClick: onBack, className: "mb-4 text-sm text-[#C2185B] hover:underline", children: "\u2190 Back" })), step === "register" && (_jsxs(_Fragment, { children: [_jsx("h2", { className: "text-xl font-semibold text-neutral-900", children: "Create Account" }), _jsx("p", { className: "mt-1 text-sm text-neutral-500", children: "Enter your details to get started." }), _jsxs("form", { onSubmit: handleRegister, className: "mt-6 space-y-4", children: [registerError && (_jsx("div", { className: "rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600", children: registerError })), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "First name" }), _jsx("input", { value: firstName, onChange: (e) => setFirstName(e.target.value), placeholder: "John", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "Last name" }), _jsx("input", { value: lastName, onChange: (e) => setLastName(e.target.value), placeholder: "Doe", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "Email" }), _jsx("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), placeholder: "you@example.com", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "Username" }), _jsxs("div", { className: "relative", children: [_jsx("input", { value: username, onChange: (e) => setUsername(e.target.value), placeholder: "johndoe", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 pr-8 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" }), _jsx("span", { className: "absolute right-3 top-1/2 -translate-y-1/2", children: checkingUsername ? (_jsxs("svg", { className: "h-4 w-4 animate-spin text-neutral-400", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] })) : usernameAvailable === true ? (_jsx("svg", { className: "h-4 w-4 text-green-500", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M5 13l4 4L19 7" }) })) : usernameAvailable === false ? (_jsx("svg", { className: "h-4 w-4 text-red-500", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M6 18L18 6M6 6l12 12" }) })) : null })] }), usernameAvailable === false && (_jsx("p", { className: "mt-0.5 text-xs text-red-500", children: "This username is taken" }))] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "Password" }), _jsxs("div", { className: "relative", children: [_jsx("input", { type: showPassword ? "text" : "password", value: password, onChange: (e) => setPassword(e.target.value), placeholder: "Min 8 chars, 1 capital", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 pr-10 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" }), _jsx("button", { type: "button", onClick: () => setShowPassword(!showPassword), className: "absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600", children: showPassword ? (_jsx("svg", { className: "h-4 w-4", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" }) })) : (_jsxs("svg", { className: "h-4 w-4", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: [_jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M15 12a3 3 0 11-6 0 3 3 0 016 0z" }), _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" })] })) })] }), _jsx("p", { className: "mt-1 text-xs text-neutral-400", children: "8+ characters, 1 capital letter" })] }), _jsx("button", { type: "submit", disabled: registerLoading || !firstName.trim() || !lastName.trim() || !email.trim() || !username.trim() || !password.trim() || usernameAvailable === false, className: "w-full rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50", children: registerLoading ? "Creating account..." : "Create Account" })] })] })), step === "otp" && (_jsxs("div", { className: "py-4", children: [_jsx("h2", { className: "text-xl font-semibold text-neutral-900", children: "Verify Your Email" }), _jsxs("p", { className: "mt-1 text-sm text-neutral-500", children: ["We sent a 6-digit code to ", _jsx("strong", { children: email }), ". Enter it below."] }), otpError && (_jsx("div", { className: "mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600", children: otpError })), _jsx("div", { className: "mt-6 flex justify-center gap-2", children: otp.map((digit, i) => (_jsx("input", { ref: (el) => { otpRefs.current[i] = el; }, type: "text", inputMode: "numeric", maxLength: 1, value: digit, onChange: (e) => handleOtpChange(i, e.target.value), onKeyDown: (e) => handleOtpKeyDown(i, e), className: "h-12 w-10 rounded-lg border border-neutral-300 text-center text-lg font-semibold outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" }, i))) }), _jsx("button", { type: "button", onClick: handleVerify, disabled: otpLoading || otp.join("").length < 6, className: "mt-6 w-full rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50", children: otpLoading ? "Verifying..." : "Verify Email" }), _jsx("div", { className: "mt-4 text-center", children: _jsx("button", { type: "button", onClick: resendOtp, disabled: otpLoading, className: "text-sm text-[#C2185B] hover:underline disabled:opacity-50", children: "Resend code" }) })] })), step === "community" && (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", onClick: () => setStep("otp"), className: "mb-4 text-sm text-[#C2185B] hover:underline", children: "\u2190 Back" }), _jsx("h2", { className: "text-xl font-semibold text-neutral-900", children: "Create Your Community" }), _jsx("p", { className: "mt-1 text-sm text-neutral-500", children: "Fill in the details for your new community." }), _jsx("div", { className: "mt-6", children: _jsx(CommunityDetailsForm, { data: communityData, onChange: setCommunityData, checkName: checkCommunityName, step: communityStep }) }), submitError && (_jsx("div", { className: "mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600", children: submitError })), _jsxs("div", { className: "mt-6 flex items-center justify-between", children: [communityStep === 2 ? (_jsx("button", { type: "button", onClick: () => setCommunityStep(1), className: "rounded-lg border border-neutral-300 px-5 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50", children: "Previous" })) : (_jsx("div", {})), communityStep === 1 ? (_jsx("button", { type: "button", onClick: () => setCommunityStep(2), disabled: !communityData.community_name.trim(), className: "rounded-lg bg-[#C2185B] px-6 py-2 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50", children: "Next" })) : (_jsx("button", { type: "button", onClick: handleCreate, disabled: submitting || !communityData.agree18 || !communityData.agreeContent, className: "rounded-lg bg-[#C2185B] px-6 py-2 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50", children: submitting ? "Creating..." : "Create Community" }))] })] }))] }));
}
//# sourceMappingURL=new-user-flow.js.map