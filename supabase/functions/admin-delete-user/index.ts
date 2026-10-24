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
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
}

// Guard blocks — same logic as delete-account for consistency.
// Blocks if user cannot be safely deleted/scheduled for account deletion.
async function checkDeletionGuards(userId: string): Promise<{ error: string; owned?: string[] } | null> {
  // 1. Owns any community (live or soft-deleted) — FK blocks hard delete.
  const { data: owned } = await supabase
    .from("communities")
    .select("name")
    .eq("owner_id", userId)
  if (owned && owned.length > 0) {
    const names = owned.map((c: any) => `"${c.name}"`).join(", ")
    return {
      error: `You can't delete/schedule this account yet — they're the organizer of ${names}. ` +
        "Please have them close their community first, then try again.",
      owned: owned.map((c: any) => c.name),
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
      error: `This user has ${upcomingRegs.length} upcoming registration(s). ` +
        "They must cancel them or wait for the events to pass before scheduling deletion.",
    }
  }

  // 3. Has a pending payment (money in flight).
  const { data: pendingPays } = await supabase
    .from("payments")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "pending")
    .not("razorpay_order_id", "is", null)
    .lt("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
  if (pendingPays && pendingPays.length > 0) {
    return {
      error: "This user has a payment being processed. Please wait for it to complete or fail before scheduling deletion.",
    }
  }

  // 4. Has a refund in flight.
  const { data: refundClaims } = await supabase
    .from("payments")
    .select("id")
    .eq("user_id", userId)
    .eq("refund_claim_state", "claimed")
  if (refundClaims && refundClaims.length > 0) {
    return {
      error: "This user has a refund being processed. Please wait for it to complete before scheduling deletion.",
    }
  }
  const { data: refundStatuses } = await supabase
    .from("payments")
    .select("id")
    .eq("user_id", userId)
    .in("refund_status", ["requested", "pending", "queued"])
  if (refundStatuses && refundStatuses.length > 0) {
    return {
      error: "This user has a refund being processed. Please wait for it to complete before scheduling deletion.",
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
      error: `This user is a team member of ${names}. They must leave those communities first, then try again.`,
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
      error: "Admin accounts cannot be scheduled for deletion. Please contact another admin.",
    }
  }

  return null
}

// Two admin modes:
//   "suspend" (default) — reversible moderation action. Sets profiles.deleted_at
//     and a ~10-year auth ban. The user's data is preserved. This is the
//     existing behavior and remains the default so existing admin-web callers
//     keep working unchanged.
//   "grace" — starts the irreversible 30-day deletion grace period. The purge
//     job will hard-delete the account after 30 days. Used for GDPR erasure
//     requests and ToS violations requiring full removal.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json", ...corsHeaders },
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

    const { data: profile } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single()
    if (!profile?.is_admin) {
      return new Response(JSON.stringify({ error: "Access denied." }), {
        status: 403, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const rl = await checkRateLimit(user.id, "admin-delete-user")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { user_id, mode } = await req.json()
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id is required." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (user_id === user.id) {
      return new Response(JSON.stringify({ error: "Cannot act on yourself." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const deletionMode: "suspend" | "grace" = mode === "grace" ? "grace" : "suspend"

    // Read deleted_at AND deletion_grace_started_at so both modes reject
    // already-processed users.
    const { data: profileData } = await supabase
      .from("profiles")
      .select("id, deleted_at, deletion_grace_started_at")
      .eq("id", user_id)
      .single()

    if (!profileData) {
      return new Response(JSON.stringify({ error: "User not found." }), {
        status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }
    if (profileData.deleted_at) {
      return new Response(JSON.stringify({ error: "User is already suspended." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }
    if (profileData.deletion_grace_started_at) {
      return new Response(JSON.stringify({ error: "User already has a pending deletion." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (deletionMode === "grace") {
      // Run same guards as self-delete to prevent scheduling when not allowed.
      const guardResult = await checkDeletionGuards(user_id)
      if (guardResult) {
        return new Response(JSON.stringify({
          error: guardResult.error,
          ...(guardResult.owned && { owned_communities: guardResult.owned }),
        }), {
          status: 409,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }

      // Start the 30-day grace.
      const now = new Date().toISOString()
      const { error: graceErr } = await supabase
        .from("profiles")
        .update({ deletion_grace_started_at: now })
        .eq("id", user_id)
      if (graceErr) throw graceErr

      // Log them out immediately on all devices (same as self-delete flow).
      try {
        await supabase.auth.admin.signOut(user_id, "global" as any)
      } catch (signOutErr) {
        logError("admin-delete-user signout", signOutErr)
      }

      // Audit: no email, no PII in details.
      await supabase.from("audit_log").insert({
        actor_id: user.id,
        action: "deletion_grace_started_by_admin",
        target_type: "user",
        target_id: user_id,
        details: { grace_days: GRACE_DAYS },
      })

      return new Response(JSON.stringify({
        success: true,
        mode: "grace",
        grace_days: GRACE_DAYS,
      }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // suspend mode (default, reversible).
    const now = new Date().toISOString()
    const { error: suspendErr } = await supabase
      .from("profiles")
      .update({ deleted_at: now })
      .eq("id", user_id)
    if (suspendErr) throw suspendErr
    // Auth-level ban: blocks fresh sign-ins (password AND Google OAuth) on every
    // client — the soft-delete timestamp alone is never consulted by GoTrue.
    // ~10 years: effectively permanent but reversible via admin-undelete-user.
    await supabase.auth.admin.updateUserById(user_id, { ban_duration: "87600h" })

    // Audit: NO email in details (D-fix: previously leaked the user's email
    // into audit_log.details, readable by any admin).
    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: "user_suspended",
      target_type: "user",
      target_id: user_id,
      details: null,
    })

    return new Response(JSON.stringify({ success: true, mode: "suspend" }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    logError("admin-delete-user", err)
    return new Response(JSON.stringify({ error: "Something went wrong." }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
