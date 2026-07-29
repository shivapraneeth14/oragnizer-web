import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../../supabase";
import { uploadToCloudinary } from "../../lib/cloudinary";
import { useEvents } from "../../hooks/use-events";
export default function MediaSection({ communityId }) {
    const [communityMedia, setCommunityMedia] = useState([]);
    const [eventMedia, setEventMedia] = useState([]);
    const [selectedEventId, setSelectedEventId] = useState("");
    const [uploading, setUploading] = useState(false);
    const [uploadTarget, setUploadTarget] = useState("community");
    const [uploadType, setUploadType] = useState("image");
    const [communityMediaLoading, setCommunityMediaLoading] = useState(true);
    const [eventMediaLoading, setEventMediaLoading] = useState(false);
    const [communityMediaError, setCommunityMediaError] = useState(null);
    const [eventMediaError, setEventMediaError] = useState(null);
    const fileInputRef = useRef(null);
    const { events } = useEvents(communityId);
    const fetchCommunityMedia = useCallback(async () => {
        if (!communityId)
            return;
        setCommunityMediaLoading(true);
        setCommunityMediaError(null);
        const { data, error } = await supabase
            .from("media")
            .select("*")
            .eq("mediable_type", "community")
            .eq("mediable_id", communityId)
            .order("sort_order", { ascending: true });
        if (error) {
            setCommunityMediaError(error.message);
        }
        else if (data) {
            setCommunityMedia(data);
        }
        setCommunityMediaLoading(false);
    }, [communityId]);
    const fetchEventMedia = useCallback(async (eventId) => {
        if (!eventId) {
            setEventMedia([]);
            return;
        }
        setEventMediaLoading(true);
        setEventMediaError(null);
        const { data, error } = await supabase
            .from("media")
            .select("*")
            .eq("mediable_type", "event")
            .eq("mediable_id", eventId)
            .order("sort_order", { ascending: true });
        if (error) {
            setEventMediaError(error.message);
        }
        else if (data) {
            setEventMedia(data);
        }
        setEventMediaLoading(false);
    }, []);
    useEffect(() => { fetchCommunityMedia(); }, [fetchCommunityMedia]);
    useEffect(() => { fetchEventMedia(selectedEventId); }, [selectedEventId, fetchEventMedia]);
    const handleUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file || !communityId)
            return;
        setUploading(true);
        try {
            const url = await uploadToCloudinary(file);
            const mediableId = uploadTarget === "community" ? communityId : selectedEventId;
            if (!mediableId)
                return;
            const { data: existing } = await supabase
                .from("media")
                .select("sort_order")
                .eq("mediable_type", uploadTarget)
                .eq("mediable_id", mediableId)
                .order("sort_order", { ascending: false })
                .limit(1);
            const nextOrder = existing && existing.length > 0 ? existing[0].sort_order + 1 : 0;
            await supabase.from("media").insert({
                mediable_type: uploadTarget,
                mediable_id: mediableId,
                url,
                type: uploadType,
                sort_order: nextOrder,
            });
            if (uploadTarget === "community") {
                await fetchCommunityMedia();
            }
            else {
                await fetchEventMedia(selectedEventId);
            }
        }
        catch (err) {
            console.error("Upload failed:", err);
        }
        setUploading(false);
        if (fileInputRef.current)
            fileInputRef.current.value = "";
    };
    const handleDelete = async (item) => {
        const confirmed = window.confirm("Delete this media?");
        if (!confirmed)
            return;
        await supabase.from("media").delete().eq("id", item.id);
        if (item.mediable_type === "community") {
            await fetchCommunityMedia();
        }
        else {
            await fetchEventMedia(selectedEventId);
        }
    };
    const triggerUpload = (target, type) => {
        if (target === "event" && !selectedEventId)
            return;
        setUploadTarget(target);
        setUploadType(type);
        fileInputRef.current?.click();
    };
    return (_jsxs("div", { children: [_jsx("h3", { className: "text-xl font-semibold text-neutral-900", children: "Media Gallery" }), _jsx("p", { className: "mt-2 text-sm text-neutral-500", children: "Manage photos and videos for your community and events." }), _jsx("input", { ref: fileInputRef, type: "file", accept: uploadType === "image" ? "image/*" : "video/*", onChange: handleUpload, className: "hidden" }), _jsxs("div", { className: "mt-8", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h4", { className: "text-lg font-semibold text-neutral-800", children: "Community Photos & Videos" }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { onClick: () => triggerUpload("community", "image"), disabled: uploading, className: "flex items-center gap-1 rounded-lg bg-[#C2185B] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50", children: "+ Photo" }), _jsx("button", { onClick: () => triggerUpload("community", "video"), disabled: uploading, className: "flex items-center gap-1 rounded-lg border border-[#C2185B] px-3 py-1.5 text-sm font-medium text-[#C2185B] hover:bg-[#C2185B]/5 disabled:opacity-50", children: "+ Video" })] })] }), communityMediaLoading ? (_jsx("div", { className: "mt-4 flex justify-center py-12", children: _jsxs("svg", { className: "h-6 w-6 animate-spin text-[#C2185B]", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] }) })) : communityMediaError ? (_jsx("div", { className: "mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600", children: communityMediaError })) : (_jsxs(_Fragment, { children: [uploading && uploadTarget === "community" && (_jsx("p", { className: "mt-2 text-sm text-neutral-500", children: "Uploading..." })), _jsxs("div", { className: "mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5", children: [communityMedia.map((item) => (_jsx(MediaCard, { item: item, onDelete: handleDelete }, item.id))), communityMedia.length === 0 && !uploading && (_jsx("p", { className: "col-span-full py-8 text-center text-sm text-neutral-400", children: "No media yet. Add photos and videos for your community." }))] })] }))] }), _jsxs("div", { className: "mt-12", children: [_jsx("h4", { className: "text-lg font-semibold text-neutral-800", children: "Event Media" }), _jsx("p", { className: "mt-1 text-sm text-neutral-500", children: "Select an event to manage its photos and videos." }), _jsxs("select", { value: selectedEventId, onChange: (e) => setSelectedEventId(e.target.value), className: "mt-3 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:outline-none focus:ring-1 focus:ring-[#C2185B] max-w-xs", children: [_jsx("option", { value: "", children: "Select an event..." }), events.map((ev) => (_jsx("option", { value: ev.id, children: ev.title }, ev.id)))] }), selectedEventId && (_jsxs("div", { className: "mt-4", children: [_jsxs("div", { className: "flex gap-2 mb-4", children: [_jsx("button", { onClick: () => triggerUpload("event", "image"), disabled: uploading, className: "flex items-center gap-1 rounded-lg bg-[#C2185B] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50", children: "+ Photo" }), _jsx("button", { onClick: () => triggerUpload("event", "video"), disabled: uploading, className: "flex items-center gap-1 rounded-lg border border-[#C2185B] px-3 py-1.5 text-sm font-medium text-[#C2185B] hover:bg-[#C2185B]/5 disabled:opacity-50", children: "+ Video" })] }), uploading && uploadTarget === "event" && (_jsx("p", { className: "mb-2 text-sm text-neutral-500", children: "Uploading..." })), eventMediaLoading ? (_jsx("div", { className: "flex justify-center py-12", children: _jsxs("svg", { className: "h-6 w-6 animate-spin text-[#C2185B]", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] }) })) : eventMediaError ? (_jsx("div", { className: "rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600", children: eventMediaError })) : (_jsxs("div", { className: "grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5", children: [eventMedia.map((item) => (_jsx(MediaCard, { item: item, onDelete: handleDelete }, item.id))), eventMedia.length === 0 && !uploading && (_jsx("p", { className: "col-span-full py-8 text-center text-sm text-neutral-400", children: "No media for this event yet." }))] }))] }))] })] }));
}
function MediaCard({ item, onDelete }) {
    const isVideo = item.type === "video";
    const [imgError, setImgError] = useState(false);
    return (_jsxs("div", { className: "group relative rounded-xl border border-neutral-200 bg-white overflow-hidden shadow-soft", children: [_jsx("div", { className: "aspect-[4/3] overflow-hidden", children: isVideo ? (_jsxs("div", { className: "relative flex h-full items-center justify-center bg-neutral-900", children: [item.thumbnail_url && !imgError ? (_jsx("img", { src: item.thumbnail_url, alt: "", className: "h-full w-full object-cover", onError: () => setImgError(true) })) : (_jsx("svg", { className: "h-10 w-10 text-white/60", fill: "currentColor", viewBox: "0 0 24 24", children: _jsx("path", { d: "M8 5v14l11-7z" }) })), _jsx("div", { className: "absolute inset-0 flex items-center justify-center", children: _jsx("svg", { className: "h-10 w-10 text-white/80", fill: "currentColor", viewBox: "0 0 24 24", children: _jsx("path", { d: "M8 5v14l11-7z" }) }) })] })) : (_jsx("img", { src: item.url, alt: item.caption || "", className: "h-full w-full object-cover", onError: (e) => { e.target.style.display = "none"; } })) }), _jsx("div", { className: "absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100", children: _jsx("button", { onClick: () => onDelete(item), className: "flex h-7 w-7 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600 shadow", title: "Delete", children: _jsx("svg", { className: "h-3.5 w-3.5", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M6 18L18 6M6 6l12 12" }) }) }) }), _jsx("div", { className: "px-2.5 py-2", children: _jsx("span", { className: "inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500", children: isVideo ? "Video" : "Photo" }) })] }));
}
//# sourceMappingURL=media-section.js.map