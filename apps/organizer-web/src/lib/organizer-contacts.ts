import { supabase } from "../supabase"

export interface OrgContact {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  username: string | null
  avatar_url: string | null
}

// Contact directory (email included) for the communities the signed-in
// organizer owns or is a team member of. Client-side profile reads can no
// longer see profiles.email; this authorized service-role endpoint is the
// replacement.
export async function fetchOrganizerContacts(): Promise<Map<string, OrgContact>> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return new Map()
  try {
    const { supabaseFetch } = await import("../supabase-fetch")
    const res = await supabaseFetch("/functions/v1/organizer-contacts", session.access_token, {})
    if (!res.ok) return new Map()
    const body = await res.json().catch(() => null)
    const contacts = (body?.contacts ?? []) as OrgContact[]
    return new Map(contacts.map((c) => [c.id, c]))
  } catch {
    return new Map()
  }
}
