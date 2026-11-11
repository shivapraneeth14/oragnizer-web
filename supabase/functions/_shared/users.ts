import type { SupabaseClient } from "jsr:@supabase/supabase-js@2"

// Look up a user by exact email (case-insensitive). Uses the service-role-only
// get_user_id_by_email RPC (one indexed lookup on auth.users.email) instead of
// paginating auth.admin.listUsers, which was an amplification vector. Returns
// null when the account does not exist (callers must NOT leak this — see the
// no-enumeration contract in the password-reset functions).
//
// getUserById returns the full user including `identities`, which callers
// (e.g. forgot-password's Google-only check) rely on.
export async function findUserByEmail(
  supabase: SupabaseClient,
  email: string,
) {
  const { data: userId, error } = await supabase.rpc("get_user_id_by_email", {
    p_email: email,
  })
  if (error) throw error
  if (!userId) return null

  const { data: full, error: userError } = await supabase.auth.admin.getUserById(userId)
  if (userError) throw userError
  return full?.user ?? null
}

export function hasEmailIdentity(identities: { provider?: string }[]): boolean {
  return identities.some((identity) => identity.provider === "email")
}
