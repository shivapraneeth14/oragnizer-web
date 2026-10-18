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

// Admin-only directory of profiles including email + is_admin.
// Client-side profile reads can no longer see these columns
// (202610120005_profiles_email_is_admin_scope.sql), so the admin portal reads
// them through this authorization-checked service-role endpoint instead.
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

    const { data: caller } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .maybeSingle()
    if (!caller?.is_admin) return json({ error: "Access denied." }, 403)

    const rl = await checkRateLimit(user.id, "admin-list-profiles")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    let id: string | undefined
    let includeDeleted = false
    let deletedOnly = false
    try {
      const body = await req.json()
      id = typeof body?.id === "string" ? body.id : undefined
      includeDeleted = body?.include_deleted === true
      deletedOnly = body?.deleted_only === true
    } catch (_) {
      id = undefined
    }
    // A single-id fetch (detail page) always includes deleted users so an
    // admin can open and restore them; list views default to active-only.
    if (id) includeDeleted = true

    let query = supabase
      .from("profiles")
      .select("id, email, first_name, last_name, username, avatar_url, is_admin, created_at, deleted_at")
      .order("created_at", { ascending: false })
    if (deletedOnly) {
      query = query.not("deleted_at", "is", null)
    } else if (!includeDeleted) {
      query = query.is("deleted_at", null)
    }
    if (id) query = query.eq("id", id)

    const { data, error } = await query
    if (error) return json({ error: "Unable to load profiles." }, 500)

    return json({ profiles: data ?? [] })
  } catch {
    return json({ error: "Something went wrong." }, 500)
  }
})
