import type { SupabaseClient } from "jsr:@supabase/supabase-js@2"

export const NOT_ORGANIZER_MESSAGE =
  "You can't sign in here with this account. It doesn't have a community yet — sign up as an organizer to create one."

export async function isOrganizerAccount(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data: owned } = await supabase
    .from("communities")
    .select("id")
    .eq("owner_id", userId)
    .limit(1)
  if (owned && owned.length > 0) return true

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle()
  return profile?.is_admin === true
}
