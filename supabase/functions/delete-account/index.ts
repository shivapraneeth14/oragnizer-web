import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { GRACE_DAYS } from "../_shared/deletion.ts"
import { logError } from "../_shared/logger.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
}

// Guard blocks — each returns a human-readable 409 with the reason.
// The owner guard checks ALL owned communities (live AND soft-deleted)
// because the communities.owner_id FK is NO ACTION and blocks hard
// deletion regardless of deleted_at. This eliminates the silent-500
// that occurred when a soft-deleted community passed the old live-only
// guard but the FK aborted the cascade.
async function checkDeletionGuards(userId: string): Promise<{ error: string; owned?: string[] } | null> {
  // 1. Owns any community (live or soft-deleted) — FK blocks hard delete.
  const { data: owned } = await supabase
    .from("communities")
    .select("name")
    .eq("owner_id", userId)
  if (owned && owned.length > 0) {
    const names = owned.map((c) => `"${c.name}"`).join(", ")
    return {
      error: `You can't delete your account yet — you're the organizer of ${names}. ` +
        "Please contact support at supp.cluvo@gmail.com to close your community first. " +
        "Then try again.",
      owned: owned.map((c) => c.name),
    }
  }

  // 2. Has upcoming live registrations (event hasn't started yet).
  const { data: upcomingRegs } = await supabase
    .from("registrations")
    .select("id, events!inner(start_date)")
    .eq("user_id", userId)
    .in("status", ["pending", "confirmed"])
    .gt("events.start_date", new Date().toISOString())
  if (upcomingRegs && upcomingRegs.length > 0) {
    return {
      error: `You have ${upcomingRegs.length} upcoming registration(s). ` +
        "Please cancel them or wait for the events to pass before deleting your account.",
    }
  }

  // 3. Has a pending payment (money in flight).
  const { data: pendingPays } = await supabase
    .from("payments")
    .select("id, registrations!inner(user_id)")
    .eq("registrations.user_id", userId)
    .eq("status", "pending")
    .not("razorpay_order_id", "is", null)
    .lt("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString()) // grace 5min for in-flight
  if (pendingPays && pendingPays.length > 0) {
    return {
      error: "You have a payment being processed. Please wait for it to complete or fail before deleting your account.",
    }
  }

  // 4. Has a refund in flight.
  const { data: refundClaims } = await supabase
    .from("payments")
    .select("id, registrations!inner(user_id)")
    .eq("registrations.user_id", userId)
    .eq("refund_claim_state", "claimed")
  if (refundClaims && refundClaims.length > 0) {
    return {
      error: "You have a refund being processed. Please wait for it to complete before deleting your account.",
    }
  }
  const { data: refundStatuses } = await supabase
    .from("payments")
    .select("id, registrations!inner(user_id)")
    .eq("registrations.user_id", userId)
    .in("refund_status", ["requested", "pending", "queued"])
  if (refundStatuses && refundStatuses.length > 0) {
    return {
      error: "You have a refund being processed. Please wait for it to complete before deleting your account.",
    }
  }

  // 5. Is on a community team (MODERATOR/ORGANIZER/OWNER role).
  const { data: teamRows } = await supabase
    .from("community_members")
    .select("role, communities!inner(name)")
    .eq("user_id", userId)
    .in("role", ["MODERATOR", "ORGANIZER", "OWNER"])
  if (teamRows && teamRows.length > 0) {
    const names = teamRows.map((r: any) => `"${r.communities?.name}"`).join(", ")
    return {
      error: `You're a team member of ${names}. Please leave those communities first, then try again.`,
    }
  }

  // 6. Is a platform admin.
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .single()
  if (profile?.is_admin) {
    return {
      error: "Admin accounts cannot be self-deleted. Please contact another admin.",
    }
  }

  return null
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized." }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session." }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const ip = getClientIp(req)
    const rl = await checkRateLimit(ip, "delete-account")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    // Idempotent: if already in grace, return success without re-running guards.
    const { data: existing } = await supabase
      .from("profiles")
      .select("deletion_grace_started_at")
      .eq("id", user.id)
      .single()
    if (existing?.deletion_grace_started_at) {
      return new Response(JSON.stringify({
        success: true,
        grace_days: GRACE_DAYS,
        grace_started_at: existing.deletion_grace_started_at,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Verify consent was explicitly given (client sends consent_accepted: true).
    const body = await req.json().catch(() => ({}))
    if (body.consent_accepted !== true) {
      return new Response(JSON.stringify({
        error: "You must confirm you understand the deletion terms before proceeding.",
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Run all deletion guards.
    const guardResult = await checkDeletionGuards(user.id)
    if (guardResult) {
      return new Response(JSON.stringify({
        error: guardResult.error,
        ...(guardResult.owned && { owned_communities: guardResult.owned }),
      }), {
        status: 409,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Start the grace period. This is the only write — no data is deleted.
    const now = new Date().toISOString()
    const { error: graceErr } = await supabase
      .from("profiles")
      .update({ deletion_grace_started_at: now })
      .eq("id", user.id)
    if (graceErr) throw graceErr

    // Global sign-out: kill all sessions on every device. The Admin API
    // expects the caller's JWT here, not the user id.
    const { error: signOutErr } = await supabase.auth.admin.signOut(token, "global")
    if (signOutErr) logError("delete-account signout", signOutErr)

    // Audit: record the request (no email, no PII in details).
    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: "deletion_requested",
      target_type: "user",
      target_id: user.id,
      details: { grace_days: GRACE_DAYS },
    })

    return new Response(JSON.stringify({
      success: true,
      grace_days: GRACE_DAYS,
      grace_started_at: now,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    logError("delete-account", err)
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
