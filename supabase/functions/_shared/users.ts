import type { SupabaseClient } from "jsr:@supabase/supabase-js@2"

// Look up a user by exact email (case-insensitive). Auth lists users
// page-by-page; the cap prevents unbounded scans of a badly-behaved project.
// Returns null when the account does not exist (callers must NOT leak this —
// see the no-enumeration contract in the password-reset functions).
//
// The list endpoint does not include `identities`, so after finding a match we
// re-fetch the single user (which does) and merge its identities in. Callers
// (e.g. forgot-password's Google-only check) rely on these being present.
export async function findUserByEmail(
  supabase: SupabaseClient,
  email: string,
) {
  const perPage = 1000
  const maxPages = 100
  for (let page = 1; page <= maxPages; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })
    if (error) throw error
    if (!data?.users) break
    const found = data.users.find((u) => (u.email ?? "").toLowerCase() === email)
    if (found) {
      const { data: full } = await supabase.auth.admin.getUserById(found.id)
      const identities = full?.user?.identities
      return identities ? { ...found, identities } : found
    }
    if (data.users.length < perPage) break
  }
  return null
}

export function hasEmailIdentity(identities: { provider?: string }[]): boolean {
  return identities.some((identity) => identity.provider === "email")
}