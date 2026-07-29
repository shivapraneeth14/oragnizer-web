import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef, useEffect } from "react";
import { uploadToCloudinary } from "../../lib/cloudinary";
import { emptyForm } from "../../hooks/use-events";
export default function EventForm({ initial, saving, onSave, onClose }) {
    const [form, setForm] = useState(initial || emptyForm);
    const [uploading, setUploading] = useState(false);
    const [errors, setErrors] = useState({});
    const inputRef = useRef(null);
    useEffect(() => {
        if (initial)
            setForm(initial);
    }, [initial]);
    const update = (key, value) => {
        setForm((prev) => ({ ...prev, [key]: value }));
    };
    const handleImageUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file)
            return;
        setUploading(true);
        try {
            const url = await uploadToCloudinary(file);
            update("image_url", url);
        }
        catch {
            // upload failed
        }
        finally {
            setUploading(false);
            e.target.value = "";
        }
    };
    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!form.title.trim())
            return;
        const errs = {};
        if (!form.start_date) {
            errs.start = "Start date is required";
        }
        else if (!isEditing) {
            const now = new Date();
            const start = new Date(form.start_date);
            const minTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
            if (start < minTime) {
                errs.start = "Start date cannot be in the past";
            }
        }
        if (form.end_date && form.start_date && new Date(form.end_date) <= new Date(form.start_date)) {
            errs.end = "End date must be after start date";
        }
        setErrors(errs);
        if (Object.keys(errs).length)
            return;
        await onSave(form);
    };
    const isEditing = !!initial;
    return (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/40", children: _jsxs("div", { className: "max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl", children: [_jsxs("div", { className: "flex items-center justify-between border-b border-neutral-200 px-6 py-4", children: [_jsx("h3", { className: "text-lg font-semibold text-neutral-900", children: isEditing ? "Edit Event" : "Create Event" }), _jsx("button", { onClick: onClose, className: "rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600", children: _jsx("svg", { className: "h-5 w-5", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M6 18L18 6M6 6l12 12" }) }) })] }), _jsxs("form", { onSubmit: handleSubmit, className: "space-y-4 px-6 py-5", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Event Image" }), _jsx("input", { ref: inputRef, type: "file", accept: "image/*", onChange: handleImageUpload, className: "hidden" }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "flex h-20 w-32 items-center justify-center overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50", children: form.image_url ? (_jsx("img", { src: form.image_url, alt: "", className: "h-full w-full object-cover" })) : (_jsx("span", { className: "text-xs text-neutral-400", children: "No image" })) }), _jsxs("div", { className: "flex flex-col gap-1.5", children: [_jsx("button", { type: "button", onClick: () => inputRef.current?.click(), disabled: uploading, className: "rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50", children: uploading ? "Uploading..." : form.image_url ? "Change" : "Upload" }), form.image_url && (_jsx("button", { type: "button", onClick: () => update("image_url", ""), className: "rounded-lg px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50", children: "Remove" }))] })] })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Title *" }), _jsx("input", { value: form.title, onChange: (e) => update("title", e.target.value), placeholder: "Event title", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Description" }), _jsx("textarea", { value: form.description, onChange: (e) => update("description", e.target.value), placeholder: "Describe your event...", rows: 3, className: "w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Start *" }), _jsx("input", { type: "datetime-local", value: form.start_date, onChange: (e) => { setErrors((p) => ({ ...p, start: undefined })); update("start_date", e.target.value); }, min: isEditing ? undefined : new Date().toISOString().slice(0, 16), className: `w-full rounded-lg border px-3.5 py-2 text-sm outline-none transition focus:ring-1 focus:ring-[#C2185B]/20 ${errors.start ? "border-red-400 focus:border-red-500" : "border-neutral-300 focus:border-[#C2185B]"}` }), errors.start && _jsx("p", { className: "mt-1 text-xs text-red-500", children: errors.start })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "End" }), _jsx("input", { type: "datetime-local", value: form.end_date, onChange: (e) => { setErrors((p) => ({ ...p, end: undefined })); update("end_date", e.target.value); }, className: `w-full rounded-lg border px-3.5 py-2 text-sm outline-none transition focus:ring-1 focus:ring-[#C2185B]/20 ${errors.end ? "border-red-400 focus:border-red-500" : "border-neutral-300 focus:border-[#C2185B]"}` }), errors.end && _jsx("p", { className: "mt-1 text-xs text-red-500", children: errors.end })] })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Location" }), _jsx("input", { value: form.location, onChange: (e) => update("location", e.target.value), placeholder: "Event location", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Capacity" }), _jsx("input", { type: "number", min: "0", value: form.capacity, onChange: (e) => update("capacity", e.target.value), placeholder: "Max attendees", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Price (\u20B9)" }), _jsx("input", { type: "number", min: "0", step: "0.01", value: form.price, onChange: (e) => update("price", e.target.value), placeholder: "0 = Free", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Status" }), _jsx("div", { className: "flex gap-2", children: ["draft", "published"].map((s) => (_jsx("button", { type: "button", onClick: () => update("status", s), className: `rounded-lg px-4 py-1.5 text-xs font-medium transition ${form.status === s ? "bg-[#C2185B] text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`, children: s.charAt(0).toUpperCase() + s.slice(1) }, s))) })] }), _jsxs("div", { className: "flex justify-end gap-2 pt-2", children: [_jsx("button", { type: "button", onClick: onClose, className: "rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50", children: "Cancel" }), _jsx("button", { type: "submit", disabled: saving || !form.title.trim(), className: "rounded-lg bg-[#C2185B] px-4 py-2 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50", children: saving ? "Saving..." : isEditing ? "Save changes" : "Create event" })] })] })] }) }));
}
//# sourceMappingURL=event-form.js.map