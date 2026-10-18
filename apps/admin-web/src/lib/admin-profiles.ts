import type { Profile } from "shared"
import { supabase } from "../supabase"

// Client-side profile reads can no longer see email/is_admin
// (profiles columns are projected away for anon/authenticated). The admin
// portal reads them through the admin-only service-role endpoint.
export type AdminProfile = Pick<
  Profile,
  "id" | "email" | "first_name" | "last_name" | "username" | "avatar_url" | "is_admin" | "created_at"
> & { deleted_at: string | null }

export interface AdminProfileFilter {
  /** Return deleted users too (single-id fetches always do). */
  includeDeleted?: boolean
  /** Return ONLY deleted users. */
  deletedOnly?: boolean
}

export async function fetchAdminProfiles(id?: string, filter?: AdminProfileFilter): Promise<AdminProfile[]> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return []
  const { supabaseFetch } = await import("../supabase-fetch")
  const body: Record<string, unknown> = {}
  if (id) body.id = id
  if (filter?.includeDeleted) body.include_deleted = true
  if (filter?.deletedOnly) body.deleted_only = true
  const res = await supabaseFetch(
    "/functions/v1/admin-list-profiles",
    session.access_token,
    body,
  )
  if (!res.ok) return []
  const parsed = await res.json().catch(() => null)
  return (parsed?.profiles ?? []) as AdminProfile[]
}
