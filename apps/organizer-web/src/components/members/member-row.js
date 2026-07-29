import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
export default function MemberRow({ member, currentUserId, communityId, onRemoved }) {
    const [removing, setRemoving] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const isOwner = member.role === "OWNER";
    const isSelf = member.user_id === currentUserId;
    const handleRemove = async () => {
        setRemoving(true);
        try {
            const token = (await import("../../supabase")).supabase.auth.getSession();
            const accessToken = (await token).data.session?.access_token;
            if (!accessToken)
                return;
            const { supabaseFetch } = await import("../../supabase-fetch");
            const res = await supabaseFetch("/functions/v1/remove-member", accessToken, { community_id: communityId, user_id: member.user_id });
            const data = await res.json();
            if (!res.ok) {
                alert(data.error || "Failed to remove member");
            }
            else {
                onRemoved();
            }
        }
        catch {
            alert("Something went wrong");
        }
        setRemoving(false);
        setConfirm(false);
    };
    return (_jsxs("tr", { className: "border-b border-neutral-100 transition-colors hover:bg-neutral-50", children: [_jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "flex h-8 w-8 items-center justify-center rounded-full bg-[#C2185B]/10 text-xs font-bold text-[#C2185B]", children: (member.username || member.email || "?")[0].toUpperCase() }), _jsxs("span", { className: "font-medium text-neutral-700", children: ["@", member.username || member.email?.split("@")[0] || "unknown"] })] }) }), _jsx("td", { className: "px-4 py-3", children: _jsx("span", { className: `inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${isOwner
                        ? "bg-[#C2185B]/10 text-[#C2185B]"
                        : "bg-neutral-100 text-neutral-600"}`, children: member.role }) }), _jsx("td", { className: "px-4 py-3 text-neutral-500", children: new Date(member.joined_at).toLocaleDateString() }), _jsx("td", { className: "px-4 py-3 text-right", children: !isOwner && !isSelf && (confirm ? (_jsxs("div", { className: "flex items-center justify-end gap-2", children: [_jsx("span", { className: "text-xs text-red-600", children: "Remove?" }), _jsx("button", { onClick: handleRemove, disabled: removing, className: "rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50", children: removing ? "..." : "Yes" }), _jsx("button", { onClick: () => setConfirm(false), className: "rounded bg-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-300", children: "No" })] })) : (_jsx("button", { onClick: () => setConfirm(true), className: "text-xs font-medium text-red-500 hover:text-red-700 transition-colors", children: "Remove" }))) })] }));
}
//# sourceMappingURL=member-row.js.map