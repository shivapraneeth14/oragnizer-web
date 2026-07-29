import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from "react";
import { supabase } from "../../supabase";
const statusColors = {
    draft: "bg-neutral-100 text-neutral-600",
    published: "bg-green-100 text-green-700",
    cancelled: "bg-red-100 text-red-600",
    completed: "bg-blue-100 text-blue-600",
};
const regStatusColors = {
    pending: "bg-yellow-100 text-yellow-700",
    confirmed: "bg-green-100 text-green-700",
    cancelled: "bg-red-100 text-red-600",
    attended: "bg-blue-100 text-blue-600",
};
const payStatusColors = {
    pending: "bg-yellow-100 text-yellow-700",
    success: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-600",
    refunded: "bg-neutral-100 text-neutral-600",
};
function formatDateTime(dateStr) {
    return new Date(dateStr).toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric", year: "numeric",
        hour: "2-digit", minute: "2-digit",
    });
}
function formatPrice(paise) {
    if (paise === 0)
        return "Free";
    return `₹${(paise / 100).toLocaleString("en-IN")}`;
}
export default function EventDetail({ event, onEdit, onCancel, onClose }) {
    const [registrations, setRegistrations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    useEffect(() => {
        setLoading(true);
        supabase
            .from("registrations")
            .select("id, user_id, status, registered_at, profiles(email, first_name, last_name), payments(amount, status)")
            .eq("event_id", event.id)
            .is("deleted_at", null)
            .order("registered_at", { ascending: false })
            .then(({ data, error }) => {
            if (error) {
                setError(error.message);
            }
            else {
                setRegistrations(data);
            }
            setLoading(false);
        });
    }, [event.id]);
    return (_jsxs("div", { children: [_jsxs("button", { onClick: onClose, className: "mb-4 flex items-center gap-1.5 text-sm font-medium text-[#C2185B] hover:text-[#A0154A]", children: [_jsx("svg", { className: "h-4 w-4", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M19 12H5m7-7l-7 7 7 7" }) }), "Back to Events"] }), _jsxs("div", { className: "mx-auto max-w-3xl", children: [event.image_url && (_jsx("div", { className: "overflow-hidden rounded-xl", children: _jsx("img", { src: event.image_url, alt: "", className: "h-56 w-full object-cover" }) })), _jsxs("div", { className: "mt-6 space-y-6", children: [_jsxs("div", { className: "flex items-start justify-between gap-4", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-2xl font-bold text-neutral-900", children: event.title }), event.description && (_jsx("p", { className: "mt-2 text-sm text-neutral-600", children: event.description }))] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("button", { onClick: () => {
                                                    const base = import.meta.env.VITE_APP_DEEPLINK_BASE || 'cluvo://';
                                                    const url = `${base}events/${event.id}`;
                                                    navigator.clipboard.writeText(url);
                                                }, className: "flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 transition-colors", children: [_jsx("svg", { className: "h-3.5 w-3.5", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" }) }), "Share"] }), _jsx("span", { className: `shrink-0 rounded-full px-3 py-1 text-xs font-medium ${statusColors[event.status]}`, children: event.status.charAt(0).toUpperCase() + event.status.slice(1) })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-x-8 gap-y-4 rounded-xl border border-neutral-200 bg-white p-6", children: [_jsx(DetailItem, { label: "Start", value: formatDateTime(event.start_date) }), event.end_date ? _jsx(DetailItem, { label: "End", value: formatDateTime(event.end_date) }) : null, event.location ? _jsx(DetailItem, { label: "Location", value: event.location }) : null, event.capacity ? (_jsx(DetailItem, { label: "Capacity", value: `${event.booked_count || 0} / ${event.capacity}` })) : null, _jsx(DetailItem, { label: "Price", value: formatPrice(event.price) })] }), event.status !== "cancelled" && event.status !== "completed" && (_jsxs("div", { className: "flex gap-3", children: [_jsxs("button", { onClick: onEdit, className: "flex items-center gap-1.5 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50", children: [_jsx("svg", { className: "h-4 w-4", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" }) }), "Edit Event"] }), _jsxs("button", { onClick: onCancel, className: "flex items-center gap-1.5 rounded-lg bg-red-50 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-100", children: [_jsx("svg", { className: "h-4 w-4", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" }) }), "Cancel Event"] })] })), _jsxs("div", { children: [_jsxs("h3", { className: "text-lg font-semibold text-neutral-900", children: ["Registrations ", !loading && `(${registrations.length})`] }), error && (_jsx("p", { className: "mt-2 text-sm text-red-500", children: error })), loading ? (_jsx("div", { className: "flex justify-center py-10", children: _jsxs("svg", { className: "h-5 w-5 animate-spin text-[#C2185B]", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] }) })) : registrations.length === 0 ? (_jsxs("div", { className: "mt-3 rounded-xl border border-neutral-200 py-10 text-center", children: [_jsx("svg", { className: "mx-auto h-8 w-8 text-neutral-300", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 1.5, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" }) }), _jsx("p", { className: "mt-2 text-sm text-neutral-400", children: "No registrations yet." })] })) : (_jsx("div", { className: "mt-3 overflow-hidden rounded-xl border border-neutral-200", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium text-neutral-500", children: [_jsx("th", { className: "px-4 py-3", children: "Name" }), _jsx("th", { className: "px-4 py-3", children: "Email" }), _jsx("th", { className: "px-4 py-3", children: "Status" }), _jsx("th", { className: "px-4 py-3", children: "Payment" }), _jsx("th", { className: "px-4 py-3", children: "Date" })] }) }), _jsx("tbody", { className: "divide-y divide-neutral-100", children: registrations.map((reg) => (_jsxs("tr", { className: "hover:bg-neutral-50", children: [_jsx("td", { className: "px-4 py-3 text-neutral-900", children: [reg.profiles?.first_name, reg.profiles?.last_name].filter(Boolean).join(" ") || "—" }), _jsx("td", { className: "px-4 py-3 text-neutral-500", children: reg.profiles?.email || "—" }), _jsx("td", { className: "px-4 py-3", children: _jsx("span", { className: `rounded-full px-2 py-0.5 text-xs font-medium ${regStatusColors[reg.status]}`, children: reg.status.charAt(0).toUpperCase() + reg.status.slice(1) }) }), _jsx("td", { className: "px-4 py-3", children: reg.payments && reg.payments.length > 0 ? (_jsx("span", { className: `rounded-full px-2 py-0.5 text-xs font-medium ${payStatusColors[reg.payments[0].status]}`, children: reg.payments[0].status.charAt(0).toUpperCase() + reg.payments[0].status.slice(1) })) : (_jsx("span", { className: "text-xs text-neutral-400", children: "\u2014" })) }), _jsx("td", { className: "px-4 py-3 text-xs text-neutral-500", children: new Date(reg.registered_at).toLocaleDateString("en-US", {
                                                                    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                                                                }) })] }, reg.id))) })] }) }))] })] })] })] }));
}
function DetailItem({ label, value }) {
    return (_jsxs("div", { children: [_jsx("p", { className: "text-xs font-medium text-neutral-500", children: label }), _jsx("p", { className: "mt-0.5 text-sm text-neutral-900", children: value })] }));
}
//# sourceMappingURL=event-detail.js.map