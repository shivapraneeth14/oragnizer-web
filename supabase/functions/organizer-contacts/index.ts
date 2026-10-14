import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  })
}

const TEAM_ROLES = ["OWNER", "ORGANIZER", "MODERATOR"]
const CHUNK = 200

async function inChunks<T>(
  ids: string[],
  fn: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(...(await fn(ids.slice(i, i + CHUNK))))
  }
  return out
}

// Returns the contact directory (email included) for the communities a caller
// owns or is a team member of. Authorization is enforced server-side here; the
// client can no longer read profiles.email directly
// (202610120005_profiles_email_is_admin_scope.sql).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return json({ error: "Unauthorized." }, 401)
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) return json({ error: "Invalid session." }, 401)

    const rl = await checkRateLimit(user.id, "organizer-contacts")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { data: caller } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .maybeSingle()
    const isAdmin = caller?.is_admin === true

    // Communities the caller may see contacts for.
    let communityIds: string[] = []
    if (isAdmin) {
      const { data: all } = await supabase.from("communities").select("id")
      communityIds = (all ?? []).map((c) => c.id)
    } else {
      const { data: owned } = await supabase
        .from("communities")
        .select("id")
        .eq("owner_id", user.id)
      const { data: team } = await supabase
        .from("community_members")
        .select("community_id")
        .eq("user_id", user.id)
        .in("role", TEAM_ROLES)
      communityIds = Array.from(
        new Set([
          ...(owned ?? []).map((c) => c.id),
          ...(team ?? []).map((m) => m.community_id),
        ]),
      )
    }

    if (communityIds.length === 0) {
      return json({ contacts: [] })
    }

    // 1. Members of any managed community.
    const memberRows = await inChunks(communityIds, async (batch) => {
      const { data } = await supabase
        .from("community_members")
        .select("user_id")
        .in("community_id", batch)
      return data ?? []
    })

    // 2. Registrants for events of any managed community.
    const regRows = await inChunks(communityIds, async (batch) => {
      const { data } = await supabase
        .from("registrations")
        .select("user_id, events!inner(community_id)")
        .in("events.community_id", batch)
        .is("deleted_at", null)
      return data ?? []
    })

    const userIds = Array.from(
      new Set([
        ...memberRows.map((r) => r.user_id),
        ...regRows.map((r) => r.user_id),
        user.id, // the caller can always see their own contact details
      ]),
    )

    const profileRows = await inChunks(userIds, async (batch) => {
      const { data } = await supabase
        .from("profiles")
        .select("id, email, first_name, last_name, username, avatar_url")
        .in("id", batch)
        .is("deleted_at", null)
      return data ?? []
    })

    return json({ contacts: profileRows })
  } catch {
    return json({ error: "Something went wrong." }, 500)
  }
})
