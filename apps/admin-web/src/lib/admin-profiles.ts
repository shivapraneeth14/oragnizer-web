import type { Profile } from "shared"
import { supabase } from "../supabase"

// Client-side profile reads can no longer see email/is_admin
// (profiles columns are projected away for anon/authenticated). The admin
// portal reads them through the admin-only service-role endpoint.
export type AdminProfile = Pick<
  Profile,
  "id" | "email" | "first_name" | "last_name" | "username" | "avatar_url" | "is_admin" | "created_at"
>

export async function fetchAdminProfiles(id?: string): Promise<AdminProfile[]> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return []
  const { supabaseFetch } = await import("../supabase-fetch")
  const res = await supabaseFetch(
    "/functions/v1/admin-list-profiles",
    session.access_token,
    id ? { id } : {},
  )
  if (!res.ok) return []
  const body = await res.json().catch(() => null)
  return (body?.profiles ?? []) as AdminProfile[]
}
