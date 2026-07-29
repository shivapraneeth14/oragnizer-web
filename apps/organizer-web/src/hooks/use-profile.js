import { useState, useEffect, useCallback } from "react";
import { supabase } from "../supabase";
import { useAuth } from "../auth-context";
export function useProfile() {
    const { user } = useAuth();
    const [profile, setProfile] = useState(null);
    const [community, setCommunity] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    useEffect(() => {
        if (!user)
            return;
        Promise.all([
            supabase.from("profiles").select("*").eq("id", user.id).single(),
            supabase.from("communities").select("*").eq("owner_id", user.id).maybeSingle(),
        ]).then(([profResult, commResult]) => {
            if (profResult.error) {
                setError(profResult.error.message);
            }
            else {
                setProfile(profResult.data);
            }
            if (commResult.data) {
                setCommunity(commResult.data);
            }
            setLoading(false);
        });
    }, [user]);
    const updateProfile = useCallback(async (updates) => {
        if (!user)
            return;
        setSaving(true);
        setError(null);
        setSuccess(null);
        const { error } = await supabase
            .from("profiles")
            .update(updates)
            .eq("id", user.id);
        if (error) {
            setError(error.message);
        }
        else {
            setProfile((prev) => prev ? { ...prev, ...updates } : null);
            setSuccess("Profile updated");
        }
        setSaving(false);
    }, [user]);
    const updateBanner = useCallback(async (banner_url) => {
        if (!community)
            return;
        setSaving(true);
        setError(null);
        setSuccess(null);
        const { error } = await supabase
            .from("communities")
            .update({ banner_url })
            .eq("id", community.id);
        if (error) {
            setError(error.message);
        }
        else {
            setCommunity((prev) => prev ? { ...prev, banner_url } : null);
            setSuccess("Banner updated");
        }
        setSaving(false);
    }, [community]);
    const updateCommunity = useCallback(async (updates) => {
        if (!community)
            return;
        setSaving(true);
        setError(null);
        setSuccess(null);
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            setSaving(false);
            return;
        }
        try {
            const { supabaseFetch } = await import("../supabase-fetch");
            const res = await supabaseFetch("/functions/v1/update-community-profile", session.access_token, updates);
            const result = await res.json();
            if (result.success) {
                setCommunity((prev) => prev ? { ...prev, ...updates } : null);
                setSuccess("Community info updated");
            }
            else {
                setError(result.error || "Something went wrong.");
            }
        }
        catch {
            setError("Connection error. Try again.");
        }
        setSaving(false);
    }, [community]);
    const clearMessages = useCallback(() => {
        setError(null);
        setSuccess(null);
    }, []);
    return { profile, community, loading, saving, error, success, updateProfile, updateBanner, updateCommunity, clearMessages };
}
//# sourceMappingURL=use-profile.js.map