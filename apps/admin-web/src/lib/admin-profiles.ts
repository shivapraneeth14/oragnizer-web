import type { Profile } from "shared"
import { supabase } from "../supabase"

// Client-side profile reads can no longer see email/is_admin
// (profiles columns are projected away for anon/authenticated). The admin
// portal reads them through the admin-only service-role endpoint.
export type AdminProfile = Pick<
  Profile,
  "id" | "email" | "first_name" | "last_name" | "username" | "avatar_url" | "is_admin" | "created_at"
> & { deleted_at: string | null; deletion_grace_started_at: string | null }

export interface AdminProfileFilter {
  /** Return deleted users too (single-id fetches always do). */
  includeDeleted?: boolean
  /** Return ONLY suspended users. */
  deletedOnly?: boolean
  /** Return ONLY users scheduled for deletion (grace period). */
  scheduledOnly?: boolean
}

export async function fetchAdminProfiles(id?: string, filter?: AdminProfileFilter): Promise<AdminProfile[]> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return []

    // 1. Try dedicated high-performance Admin RPC directly
    const { data: rpcProfiles, error: rpcErr } = await supabase.rpc("get_admin_profiles", {
      p_include_deleted: filter?.includeDeleted || !!id,
      p_deleted_only: !!filter?.deletedOnly,
      p_scheduled_only: !!filter?.scheduledOnly,
    })

    if (!rpcErr && rpcProfiles && Array.isArray(rpcProfiles)) {
      if (id) {
        return (rpcProfiles as AdminProfile[]).filter((p) => p.id === id)
      }
      return rpcProfiles as AdminProfile[]
    }

    // 2. Fallback: Edge Function call with proper auth and apikey headers
    const { supabaseFetch } = await import("../supabase-fetch")
    const body: Record<string, unknown> = {}
    if (id) body.id = id
    if (filter?.includeDeleted) body.include_deleted = true
    if (filter?.deletedOnly) body.deleted_only = true
    if (filter?.scheduledOnly) body.scheduled_only = true

    const res = await supabaseFetch(
      "/functions/v1/admin-list-profiles",
      session.access_token,
      body,
    )

    if (res.ok) {
      const parsed = await res.json().catch(() => null)
      if (parsed?.profiles && Array.isArray(parsed.profiles)) {
        return parsed.profiles as AdminProfile[]
      }
    }

    // 3. Last-resort fallback: Direct client query for public profile columns
    let directQuery = supabase
      .from("profiles")
      .select("id, first_name, last_name, username, avatar_url, created_at, deleted_at, deletion_grace_started_at")
      .order("created_at", { ascending: false })

    if (filter?.scheduledOnly) {
      directQuery = directQuery.is("deleted_at", null).not("deletion_grace_started_at", "is", null)
    } else if (filter?.deletedOnly) {
      directQuery = directQuery.not("deleted_at", "is", null)
    } else if (!filter?.includeDeleted && !id) {
      directQuery = directQuery.is("deleted_at", null).is("deletion_grace_started_at", null)
    }
    if (id) directQuery = directQuery.eq("id", id)

    const { data: directData } = await directQuery
    return (directData || []).map((p: any) => ({
      ...p,
      email: p.email || "",
      is_admin: false,
    })) as AdminProfile[]
  } catch (err) {
    console.error("fetchAdminProfiles error:", err)
    return []
  }
}
