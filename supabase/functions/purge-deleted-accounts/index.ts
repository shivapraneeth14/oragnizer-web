import { optionalEnv, requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { safeEqual } from "../_shared/crypto.ts"
import { recordAlert } from "../_shared/alerts.ts"
import { logError, logInfo } from "../_shared/logger.ts"
import { cloudinaryPublicId, GRACE_DAYS } from "../_shared/deletion.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)
const PURGE_SECRET = optionalEnv("PURGE_SECRET")

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-purge-secret",
}

// Maximum number of users to purge in one run (each user's scrub is many
// statements; keep one invocation bounded so it finishes inside the
// function timeout).
const BATCH_LIMIT = 5

// Cloudinary unsigned-delete via the destroy API. Uses the account API key
// and secret for Basic auth. Returns true on success, false on failure.
async function cloudinaryDestroy(publicId: string): Promise<boolean> {
  const apiKey = optionalEnv("CLOUDINARY_API_KEY")
  const apiSecret = optionalEnv("CLOUDINARY_API_SECRET")
  const cloud = optionalEnv("CLOUDINARY_CLOUD_NAME")
  if (!apiKey || !apiSecret || !cloud) return false

  const ts = Math.floor(Date.now() / 1000).toString()
  const signatureInput = `public_id=${publicId}&timestamp=${ts}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(apiSecret),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
  )
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(signatureInput))
  const signature = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0")).join("")

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloud}/image/destroy`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        public_id: publicId,
        timestamp: ts,
        api_key: apiKey,
        signature,
      }),
    },
  )
  return res.ok
}

// Scrub free-text and JSONB fields that may contain the user's email.
// Returns true if anything was written (so the caller can log it).
async function scrubUserFreeText(userId: string, email: string | null): Promise<boolean> {
  let scrubbed = false

  // content_reports: reason and details are TEXT. Scrub the reporter's email
  // before the auth user is deleted. The FK is ON DELETE SET NULL (016), so
  // the moderation record survives without its reporter.
  if (email) {
    const { data: reports, error: reportsErr } = await supabase
      .from("content_reports")
      .select("id, reason, details")
      .eq("reporter_id", userId)
    if (reportsErr) throw reportsErr
    for (const r of reports ?? []) {
      const reason = typeof r.reason === "string" ? r.reason : null
      const details = typeof r.details === "string" ? r.details : null
      const newReason = reason ? reason.replaceAll(email, "[redacted]") : reason
      const newDetails = details ? details.replaceAll(email, "[redacted]") : details
      if (newReason === reason && newDetails === details) continue
      const { error: updateErr } = await supabase
        .from("content_reports")
        .update({ reason: newReason, details: newDetails })
        .eq("id", r.id)
      if (updateErr) throw updateErr
      scrubbed = true
    }
  }

  // payment_audit_log: scrub user UUIDs and raw Cashfree responses.
  const { data: auditRows, error: auditRowsErr } = await supabase
    .from("payment_audit_log")
    .select("id, details")
  if (auditRowsErr) throw auditRowsErr
  for (const row of auditRows ?? []) {
    const d = row.details as Record<string, unknown> | null
    if (!d) continue
    const str = JSON.stringify(d)
    if (!str.includes(userId) && (!email || !str.includes(email))) continue
    const scrubbedDetails = JSON.parse(
      str
        .replaceAll(userId, "[redacted]")
        .replaceAll(email ?? "\u0000", "[redacted]")
        // Cashfree raw responses contain bank_account, ifsc, email.
        .replace(/"bank_account[^"]*":\s*"[^"]*"/g, '"bank_account":"[redacted]"')
        .replace(/"ifsc[^"]*":\s*"[^"]*"/g, '"ifsc":"[redacted]"')
        .replace(/"email[^"]*":\s*"[^"]*"/g, '"email":"[redacted]"')
    )
    const { error: auditUpdateErr } = await supabase
      .from("payment_audit_log")
      .update({ details: scrubbedDetails })
      .eq("id", row.id)
    if (auditUpdateErr) throw auditUpdateErr
    scrubbed = true
  }

  // consent_log: contains email; CASCADE-deleted with the account, but we
  // also scrub explicitly in case a prior migration left orphan rows.
  await supabase
    .from("consent_log")
    .delete()
    .eq("user_id", userId)

  return scrubbed
}

// Re-check deletion safety. Returns true if it is safe to purge.
async function safetyRecheck(userId: string): Promise<{ safe: boolean; reason?: string }> {
  // Must still be in grace and past the deadline.
  const { data: profile } = await supabase
    .from("profiles")
    .select("deletion_grace_started_at")
    .eq("id", userId)
    .single()
  if (!profile?.deletion_grace_started_at) {
    return { safe: false, reason: "grace_cleared" }
  }
  const started = new Date(profile.deletion_grace_started_at).getTime()
  if (Date.now() - started < GRACE_DAYS * 24 * 60 * 60 * 1000) {
    return { safe: false, reason: "grace_not_expired" }
  }

  // Re-run the same guards as delete-account.
  const { data: owned } = await supabase
    .from("communities").select("id").eq("owner_id", userId)
  if (owned && owned.length > 0) return { safe: false, reason: "owns_community" }

  const { data: upcoming } = await supabase
    .from("registrations")
    .select("id, events!inner(start_date)")
    .eq("user_id", userId)
    .in("status", ["pending", "confirmed"])
    .gt("events.start_date", new Date().toISOString())
  if (upcoming && upcoming.length > 0) return { safe: false, reason: "upcoming_registrations" }

  const { data: pending } = await supabase
    .from("payments").select("id")
    .eq("user_id", userId).eq("status", "pending")
  if (pending && pending.length > 0) return { safe: false, reason: "pending_payment" }

  const { data: refunds } = await supabase
    .from("payments").select("id")
    .eq("user_id", userId)
    .or("refund_claim_state.eq.claimed,refund_status.in.(requested,pending,queued)")
  if (refunds && refunds.length > 0) return { safe: false, reason: "refund_in_flight" }

  const { data: team } = await supabase
    .from("community_members").select("id")
    .eq("user_id", userId).in("role", ["MODERATOR", "ORGANIZER", "OWNER"])
  if (team && team.length > 0) return { safe: false, reason: "team_member" }

  const { data: profile2 } = await supabase
    .from("profiles").select("is_admin").eq("id", userId).single()
  if (profile2?.is_admin) return { safe: false, reason: "is_admin" }

  return { safe: true }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  const presented = req.headers.get("x-purge-secret") ?? ""
  if (!PURGE_SECRET || !safeEqual(presented, PURGE_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized." }), {
      status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  try {
    // 1. Atomically claim users whose grace has expired.
    const { data: claimed, error: claimErr } = await supabase
      .rpc("claim_due_deletions", { p_limit: BATCH_LIMIT })
    if (claimErr) throw claimErr
    const userIds: string[] = claimed ?? []

    if (userIds.length === 0) {
      // Still retry any pending media-cleanup jobs.
      await retryMediaCleanup()
      return new Response(JSON.stringify({ purged: 0, media_retried: true }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    let purged = 0
    const skipped: Array<{ userId: string; reason: string }> = []

    for (const userId of userIds) {
      // 2. Safety recheck — the world may have changed during the grace window.
      const check = await safetyRecheck(userId)
      if (!check.safe) {
        // Clear the claim so the next run (or the user) can handle it.
        await supabase
          .from("profiles")
          .update({ deletion_purging_at: null })
          .eq("id", userId)
        skipped.push({ userId, reason: check.reason ?? "unknown" })
        await recordAlert(supabase, {
          severity: "warning",
          category: "auth",
          title: "Deletion purge skipped user",
          details: { user_id: userId, reason: check.reason },
        })
        continue
      }

      // 3. Fetch user email for text scrubbing (needed before the auth user
      //    is destroyed — after that the email is gone from auth.users).
      const { data: authUser } = await supabase.auth.admin.getUserById(userId)
      const email = authUser?.user?.email ?? null

      // 4. Capture Cloudinary public_id before the profile cascades away.
      const { data: profile } = await supabase
        .from("profiles").select("avatar_url").eq("id", userId).single()
      const publicId = cloudinaryPublicId(profile?.avatar_url ?? null)

      // 5. Scrub free-text and JSONB that reference the user.
      await scrubUserFreeText(userId, email)

      // 6. Delete owned content NOT covered by the delete_user_auth_cascade RPC.
      //    - consent_log (has email column, no FK to auth.users)
      await supabase.from("consent_log").delete().eq("user_id", userId)
      //    - media_cleanup_jobs for this user's avatar (row-level, not user-linked)
      //      (handled by the Cloudinary destroy below)
      //    - waitlist_entries.user_id is ON DELETE CASCADE, so the auth-user
      //      delete below removes any waitlist rows. There is no separate
      //      `waitlist` table (the old block targeted a table that never
      //      existed in this project).

      // 7. Call the purge RPC. This deletes the auth user (cascading to
      //    profiles, registrations, payments, wallet, reviews, notifications,
      //    orders) AND nulls the audit_log tombstone. Order matters: the
      //    scrub above ran BEFORE this so free-text referencing the user
      //    was cleaned while we still had the user id and email.
      const { error: rpcErr } = await supabase.rpc("delete_user_auth_cascade", {
        p_user_id: userId,
      })
      if (rpcErr) {
        logError("purge-deleted-accounts", rpcErr)
        await supabase
          .from("profiles")
          .update({ deletion_purging_at: null })
          .eq("id", userId)
        skipped.push({ userId, reason: "rpc_failed" })
        await recordAlert(supabase, {
          severity: "critical",
          category: "auth",
          title: "Deletion purge RPC failed",
          details: { user_id: userId },
        })
        continue
      }

      // 8. Cloudinary destroy via the durable outbox.
      if (publicId) {
        await supabase.from("media_cleanup_jobs").insert({
          public_id: publicId,
          status: "pending",
        })
      }

      // 9. Audit: tombstone already written by the RPC with NULL target.
      //    Add a final marker without the user id in details.
      await supabase.from("audit_log").insert({
        actor_id: null,
        action: "account_purged",
        target_type: "user",
        target_id: null,
        details: { grace_days: GRACE_DAYS },
      })

      purged++
      logInfo("purge-deleted-accounts", `Purged user ${userId.slice(0, 8)}…`)
    }

    // 10. Retry any pending media-cleanup jobs (including ones created above).
    const mediaRetried = await retryMediaCleanup()

    return new Response(JSON.stringify({ purged, skipped, media_retried: mediaRetried }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    logError("purge-deleted-accounts", err)
    return new Response(JSON.stringify({ error: "Purge run failed." }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})

// Retry pending media-cleanup jobs with exponential backoff.
// A row is deleted only after Cloudinary confirms the destroy.
async function retryMediaCleanup(): Promise<number> {
  const { data: jobs } = await supabase
    .from("media_cleanup_jobs")
    .select("id, public_id, attempts")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .limit(20)

  let done = 0
  for (const job of jobs ?? []) {
    const ok = await cloudinaryDestroy(job.public_id)
    if (ok) {
      await supabase.from("media_cleanup_jobs").delete().eq("id", job.id)
      done++
    } else {
      const attempts = job.attempts + 1
      const backoffMin = Math.min(2 ** attempts, 24 * 60) // cap at 24h
      const update: Record<string, unknown> = {
        attempts,
        next_attempt_at: new Date(Date.now() + backoffMin * 60 * 1000).toISOString(),
        last_error_class: "cloudinary_destroy_failed",
      }
      if (attempts >= 10) update.status = "failed"
      await supabase.from("media_cleanup_jobs").update(update).eq("id", job.id)
      if (attempts >= 10) {
        await recordAlert(supabase, {
          severity: "warning",
          category: "ops",
          title: "Cloudinary media cleanup gave up",
          details: { job_id: job.id },
        })
      }
    }
  }
  return done
}
