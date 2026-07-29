import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../supabase";
export const emptyForm = {
    title: "", description: "", image_url: "",
    start_date: "", end_date: "",
    location: "", capacity: "", price: "",
    status: "draft",
};
export function eventToForm(e) {
    return {
        title: e.title,
        description: e.description || "",
        image_url: e.image_url || "",
        start_date: toDatetimeLocal(e.start_date),
        end_date: e.end_date ? toDatetimeLocal(e.end_date) : "",
        location: e.location || "",
        capacity: e.capacity?.toString() || "",
        price: (e.price / 100).toString(),
        status: e.status === "cancelled" || e.status === "completed" ? "draft" : e.status,
    };
}
function toDatetimeLocal(dateStr) {
    const d = new Date(dateStr);
    const pad = (n) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const PAGE_SIZE = 20;
export function useEvents(communityId) {
    const [events, setEvents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [error, setError] = useState(null);
    const pageRef = useRef(0);
    const fetch = useCallback(async (append = false) => {
        if (!communityId)
            return;
        if (append) {
            setLoadingMore(true);
        }
        else {
            setLoading(true);
            pageRef.current = 0;
        }
        const from = pageRef.current * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;
        const { data, error } = await supabase
            .from("events")
            .select("*")
            .eq("community_id", communityId)
            .is("deleted_at", null)
            .order("start_date", { ascending: false })
            .range(from, to);
        if (error) {
            setError(error.message);
        }
        else {
            const items = data;
            setEvents(append ? (prev) => [...prev, ...items] : items);
            setHasMore(items.length >= PAGE_SIZE);
            pageRef.current += 1;
        }
        setLoading(false);
        setLoadingMore(false);
    }, [communityId]);
    useEffect(() => { fetch(); }, [fetch]);
    const fetchNextPage = useCallback(() => fetch(true), [fetch]);
    const createEvent = useCallback(async (data, userId) => {
        const startDate = new Date(data.start_date);
        if (!data.start_date || !startDate.getTime())
            return "Start date is required";
        if (startDate < new Date())
            return "Start date cannot be in the past";
        if (data.end_date && new Date(data.end_date) <= startDate)
            return "End date must be after start date";
        const { error } = await supabase.from("events").insert({
            community_id: communityId,
            title: data.title.trim(),
            description: data.description.trim() || null,
            image_url: data.image_url || null,
            start_date: new Date(data.start_date).toISOString(),
            end_date: data.end_date ? new Date(data.end_date).toISOString() : null,
            location: data.location.trim() || null,
            capacity: data.capacity ? parseInt(data.capacity) : null,
            price: Math.round(parseFloat(data.price || "0") * 100),
            status: data.status,
            created_by: userId,
        });
        if (error)
            return error.message;
        await fetch();
        return null;
    }, [communityId, fetch]);
    const updateEvent = useCallback(async (id, data) => {
        if (data.end_date && data.start_date && new Date(data.end_date) <= new Date(data.start_date)) {
            return "End date must be after start date";
        }
        const { error } = await supabase.from("events").update({
            title: data.title.trim(),
            description: data.description.trim() || null,
            image_url: data.image_url || null,
            start_date: new Date(data.start_date).toISOString(),
            end_date: data.end_date ? new Date(data.end_date).toISOString() : null,
            location: data.location.trim() || null,
            capacity: data.capacity ? parseInt(data.capacity) : null,
            price: Math.round(parseFloat(data.price || "0") * 100),
            status: data.status,
        }).eq("id", id);
        if (error)
            return error.message;
        await fetch();
        return null;
    }, [fetch]);
    const cancelEvent = useCallback(async (id) => {
        const { error } = await supabase.from("events").update({ status: "cancelled" }).eq("id", id);
        if (error)
            return error.message;
        await fetch();
        return null;
    }, [fetch]);
    return { events, loading, loadingMore, hasMore, error, createEvent, updateEvent, cancelEvent, refresh: fetch, fetchNextPage };
}
//# sourceMappingURL=use-events.js.map