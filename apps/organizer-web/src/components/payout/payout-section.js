import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from "react";
import { supabase } from "../../supabase";
import { supabaseFetch } from "../../supabase-fetch";
export default function PayoutSection({ communityId }) {
    const [walletBalance, setWalletBalance] = useState(0);
    const [beneficiaryId, setBeneficiaryId] = useState("");
    const [accountHolder, setAccountHolder] = useState("");
    const [ifsc, setIfsc] = useState("");
    const [accountNumber, setAccountNumber] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [payouts, setPayouts] = useState([]);
    const [withdrawAmount, setWithdrawAmount] = useState("");
    const [beneficiaryLoading, setBeneficiaryLoading] = useState(false);
    useEffect(() => {
        if (!communityId)
            return;
        supabase.from("communities").select("wallet_balance, cashfree_beneficiary_id").eq("id", communityId).single().then(({ data }) => {
            if (data) {
                setWalletBalance(data.wallet_balance || 0);
                setBeneficiaryId(data.cashfree_beneficiary_id || "");
            }
        });
        supabase.from("payout_items").select("amount, status, created_at, error_message").eq("community_id", communityId).order("created_at", { ascending: false }).limit(20).then(({ data }) => {
            if (data)
                setPayouts(data);
        });
    }, [communityId]);
    const handleSaveBeneficiary = async () => {
        if (!accountHolder.trim() || !ifsc.trim() || !accountNumber.trim()) {
            setError("All bank fields are required");
            return;
        }
        setBeneficiaryLoading(true);
        setError("");
        try {
            const token = (await supabase.auth.getSession()).data.session?.access_token;
            if (!token) {
                setError("Not authenticated");
                return;
            }
            const res = await supabaseFetch("/functions/v1/create-beneficiary", token, {
                community_id: communityId,
                bank_account_holder: accountHolder.trim(),
                bank_ifsc: ifsc.trim(),
                bank_account_number: accountNumber.trim(),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error || "Failed to save beneficiary");
                return;
            }
            setBeneficiaryId(data.beneficiary_id);
            alert("Bank details saved successfully!");
        }
        catch {
            setError("Something went wrong");
        }
        setBeneficiaryLoading(false);
    };
    const handleWithdraw = async () => {
        const amount = parseInt(withdrawAmount);
        if (!amount || amount <= 0 || amount > walletBalance) {
            setError("Enter a valid amount within your balance");
            return;
        }
        setSubmitting(true);
        setError("");
        try {
            const token = (await supabase.auth.getSession()).data.session?.access_token;
            if (!token) {
                setError("Not authenticated");
                return;
            }
            const res = await supabaseFetch("/functions/v1/withdraw-wallet", token, { community_id: communityId, amount });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error || "Withdrawal failed");
                return;
            }
            alert("Withdrawal initiated! Funds will be transferred within 1-2 business days.");
            setWalletBalance((prev) => prev - amount);
            setWithdrawAmount("");
            supabase.from("payout_items").select("amount, status, created_at, error_message").eq("community_id", communityId).order("created_at", { ascending: false }).limit(20).then(({ data }) => {
                if (data)
                    setPayouts(data);
            });
        }
        catch {
            setError("Something went wrong");
        }
        setSubmitting(false);
    };
    const statusBadge = (s) => {
        const colors = {
            pending: "bg-yellow-100 text-yellow-700",
            processing: "bg-blue-100 text-blue-700",
            success: "bg-green-100 text-green-700",
            failed: "bg-red-100 text-red-600",
        };
        return _jsx("span", { className: `inline-flex rounded-full px-3 py-1 text-xs font-medium ${colors[s] || "bg-neutral-100 text-neutral-500"}`, children: s });
    };
    return (_jsxs("div", { children: [_jsx("h3", { className: "text-xl font-semibold text-neutral-900", children: "Payout Settings" }), _jsx("p", { className: "mt-2 text-sm text-neutral-500", children: "Revenue from paid events is credited to your wallet. A 10% platform commission is applied." }), _jsxs("div", { className: "mt-6 rounded-xl border border-neutral-200 bg-white p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsx("h4", { className: "font-semibold text-neutral-800", children: "Wallet Balance" }), _jsxs("span", { className: "text-2xl font-bold text-[#C2185B]", children: ["\u20B9", (walletBalance / 100).toFixed(0)] })] }), beneficiaryId ? (_jsxs("div", { className: "space-y-4", children: [_jsx("p", { className: "text-sm text-green-700 font-medium flex items-center gap-2", children: _jsx("span", { children: "\u2713 Bank account linked" }) }), _jsxs("div", { className: "flex gap-3", children: [_jsx("input", { type: "number", value: withdrawAmount, onChange: (e) => setWithdrawAmount(e.target.value), placeholder: "Amount in paise (e.g. 50000 = \u20B9500)", className: "flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:outline-none" }), _jsx("button", { onClick: handleWithdraw, disabled: submitting, className: "rounded-lg bg-[#C2185B] px-6 py-2.5 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50", children: submitting ? "Processing..." : "Withdraw" })] }), _jsx("p", { className: "text-xs text-neutral-400", children: "Enter amount in paise (e.g. 50000 = \u20B9500.00). Minimum withdrawal: \u20B9100 (10000 paise)." })] })) : (_jsxs("div", { className: "space-y-4", children: [_jsx("p", { className: "text-sm text-neutral-500", children: "Add your bank account to withdraw funds." }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-neutral-700 mb-1", children: "Account Holder Name" }), _jsx("input", { value: accountHolder, onChange: (e) => setAccountHolder(e.target.value), className: "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:outline-none", placeholder: "John Doe" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-neutral-700 mb-1", children: "IFSC Code" }), _jsx("input", { value: ifsc, onChange: (e) => setIfsc(e.target.value), className: "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:outline-none", placeholder: "HDFC0001234" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-neutral-700 mb-1", children: "Account Number" }), _jsx("input", { value: accountNumber, onChange: (e) => setAccountNumber(e.target.value), className: "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:outline-none", placeholder: "1234567890" })] })] }), error && _jsx("p", { className: "text-sm text-red-600", children: error }), _jsx("button", { onClick: handleSaveBeneficiary, disabled: beneficiaryLoading, className: "rounded-lg bg-[#C2185B] px-6 py-2.5 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50", children: beneficiaryLoading ? "Saving..." : "Save Bank Details" })] }))] }), error && !beneficiaryLoading && !submitting && beneficiaryId && (_jsx("p", { className: "mt-2 text-sm text-red-600", children: error })), payouts.length > 0 && (_jsxs("div", { className: "mt-6", children: [_jsx("h4", { className: "font-semibold text-neutral-800 mb-3", children: "Payout History" }), _jsx("div", { className: "overflow-x-auto rounded-xl border border-neutral-200 bg-white", children: _jsxs("table", { className: "w-full text-left text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-neutral-200 bg-neutral-50", children: [_jsx("th", { className: "px-4 py-3 font-medium text-neutral-600", children: "Amount" }), _jsx("th", { className: "px-4 py-3 font-medium text-neutral-600", children: "Status" }), _jsx("th", { className: "px-4 py-3 font-medium text-neutral-600", children: "Date" }), _jsx("th", { className: "px-4 py-3 font-medium text-neutral-600", children: "Note" })] }) }), _jsx("tbody", { children: payouts.map((p, i) => (_jsxs("tr", { className: "border-b border-neutral-100", children: [_jsxs("td", { className: "px-4 py-3 font-medium text-neutral-700", children: ["\u20B9", (p.amount / 100).toFixed(0)] }), _jsx("td", { className: "px-4 py-3", children: statusBadge(p.status) }), _jsx("td", { className: "px-4 py-3 text-neutral-500", children: new Date(p.created_at).toLocaleDateString() }), _jsx("td", { className: "px-4 py-3 text-neutral-500 text-xs", children: p.status === "failed" ? p.error_message || "" : "" })] }, i))) })] }) })] }))] }));
}
//# sourceMappingURL=payout-section.js.map