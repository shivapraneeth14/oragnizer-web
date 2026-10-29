import { useState, useEffect, useCallback } from "react"
import { supabase } from "../supabase"
import { useAuth } from "../auth-context"
import { COMMUNITY_CLIENT_COLUMNS_SELECT, type Profile, type Community } from "shared"

export function useProfile() {
  const { user } = useAuth()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [community, setCommunity] = useState<Community | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    Promise.all([
      supabase
        .from("profiles")
        .select("id, first_name, last_name, username, avatar_url, created_at, updated_at, deleted_at")
        .eq("id", user.id)
        .single(),
      supabase.from("communities").select(COMMUNITY_CLIENT_COLUMNS_SELECT).eq("owner_id", user.id).maybeSingle(),
    ]).then(([profResult, commResult]) => {
      if (profResult.error) {
        setError(profResult.error.message)
      } else if (profResult.data) {
        // email/is_admin are not SELECT-granted to authenticated clients
        // (202610120005); the signed-in user's own email comes from the session.
        setProfile({
          ...(profResult.data as Omit<Profile, "email" | "is_admin">),
          email: user.email ?? "",
          is_admin: false,
        })
      }
      if (commResult.data) {
        setCommunity(commResult.data as unknown as Community)
      }
      setLoading(false)
    })
  }, [user])

  const updateProfile = useCallback(async (updates: Partial<Profile>) => {
    if (!user) return
    setSaving(true)
    setError(null)
    setSuccess(null)
    const { error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", user.id)
    if (error) {
      setError(error.message)
    } else {
      setProfile((prev) => prev ? { ...prev, ...updates } : null)
      setSuccess("Profile updated")
    }
    setSaving(false)
  }, [user])

  const updateBanner = useCallback(async (banner_url: string) => {
    if (!community) return
    setSaving(true)
    setError(null)
    setSuccess(null)
    const { error } = await supabase
      .from("communities")
      .update({ banner_url })
      .eq("id", community.id)
    if (error) {
      setError(error.message)
    } else {
      setCommunity((prev) => prev ? { ...prev, banner_url } : null)
      setSuccess("Banner updated")
    }
    setSaving(false)
  }, [community])

  const updateCommunityAvatar = useCallback(async (community_avatar_url: string) => {
    if (!community) return
    setSaving(true)
    setError(null)
    setSuccess(null)
    const { error } = await supabase
      .from("communities")
      .update({ community_avatar_url })
      .eq("id", community.id)
    if (error) {
      setError(error.message)
    } else {
      setCommunity((prev) => prev ? { ...prev, community_avatar_url } : null)
      setSuccess("Community avatar updated")
    }
    setSaving(false)
  }, [community])

  const updateCommunity = useCallback(async (updates: Record<string, unknown>) => {
    if (!community) return
    setSaving(true)
    setError(null)
    setSuccess(null)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setSaving(false); return }
    try {
      const { supabaseFetch } = await import("../supabase-fetch")
      const res = await supabaseFetch("/functions/v1/update-community-profile", session.access_token, updates)
      const result = await res.json()
      if (result.success) {
        setCommunity((prev) => prev ? { ...prev, ...updates } : null)
        setSuccess("Community info updated")
      } else {
        setError(result.error || "Something went wrong.")
      }
    } catch {
      setError("Connection error. Try again.")
    }
    setSaving(false)
  }, [community])

  const clearMessages = useCallback(() => {
    setError(null)
    setSuccess(null)
  }, [])

  return { profile, community, loading, saving, error, success, updateProfile, updateBanner, updateCommunityAvatar, updateCommunity, clearMessages }
}
