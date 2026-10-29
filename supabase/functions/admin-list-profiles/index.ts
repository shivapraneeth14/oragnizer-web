import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { logError } from "../_shared/logger.ts"
import { getCorsHeaders } from "../_shared/cors.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

// Admin-only directory of profiles including email + is_admin.
// Client-side profile reads can no longer see these columns
// (202610120005_profiles_email_is_admin_scope.sql), so the admin portal reads
// them through this authorization-checked service-role endpoint instead.
Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })

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
    let scheduledOnly = false
    let reason: string | null = null
    try {
      const body = await req.json()
      id = typeof body?.id === "string" ? body.id : undefined
      includeDeleted = body?.include_deleted === true
      deletedOnly = body?.deleted_only === true
      scheduledOnly = body?.scheduled_only === true
      reason = typeof body?.reason === "string" ? body.reason.slice(0, 200) : null
    } catch (_) {
      id = undefined
    }
    // A single-id fetch (detail page) always includes deleted users so an
    // admin can open and restore them; list views default to active-only.
    if (id) includeDeleted = true

    let query = supabase
      .from("profiles")
      .select("id, email, first_name, last_name, username, avatar_url, is_admin, created_at, deleted_at, deletion_grace_started_at")
      .order("created_at", { ascending: false })
    if (scheduledOnly) {
      query = query.is("deleted_at", null).not("deletion_grace_started_at", "is", null)
    } else if (deletedOnly) {
      query = query.not("deleted_at", "is", null)
    } else if (!includeDeleted) {
      // Active means neither suspended nor scheduled for deletion.
      query = query.is("deleted_at", null).is("deletion_grace_started_at", null)
    }
    if (id) query = query.eq("id", id)

    const { data, error } = await query
    if (error) return json({ error: "Unable to load profiles." }, 500)

    // Audit admin reads of PII (email/is_admin). Single-id reads are the
    // sensitive case; list reads are recorded too, without a target id.
    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: id ? "admin_profile_read" : "admin_profiles_listed",
      target_type: "user",
      target_id: id ?? null,
      details: { reason },
    })

    return json({ profiles: data ?? [] })
  } catch (err) {
    logError("admin-list-profiles", err)
    return json({ error: "Something went wrong." }, 500)
  }
})
