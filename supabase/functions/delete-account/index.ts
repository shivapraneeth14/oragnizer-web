import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
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

    // Guard: an organizer with live communities holds wallet funds and other
    // users' event data. Deleting their identity would strand those, so block
    // with clear next steps instead of silently destroying them.
    const { data: owned } = await supabase
      .from("communities")
      .select("name")
      .eq("owner_id", user.id)
      .is("deleted_at", null)

    if (owned && owned.length > 0) {
      const names = owned.map((c) => `"${c.name}"`).join(", ")
      return new Response(JSON.stringify({
        error: "You can't delete your account yet — you're the organizer of: " + names + ". " +
          "Withdraw your wallet balance, then transfer ownership or close those communities " +
          "in the organizer web app first. Then try again.",
        owned_communities: owned.map((c) => c.name),
      }), {
        status: 409,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // User content that does NOT cascade with the profile row.
    await supabase.from("notifications").delete().eq("user_id", user.id)
    await supabase.from("reviews").delete().eq("user_id", user.id)
    await supabase.from("reports").delete().eq("reporter_id", user.id)

    // Audit trail: retain rows for operations/security, but strip any
    // personal data and sever the link (SET NULL on actor_id happens next).
    await supabase
      .from("audit_log")
      .update({ details: null, target_id: null })
      .or(`actor_id.eq.${user.id},target_id.eq.${user.id}`)

    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: "user_deleted",
      target_type: "user",
      target_id: user.id,
      details: { requested_via: "app" },
    })

    // Deleting the auth user cascades to profiles, which cascades memberships,
    // join requests, waitlists, wishlist and event messages. The SET NULL FKs
    // keep registrations/payments/events/audit rows intact, unlinked.
    //
    // Note: gotrue's admin.deleteUser() fails with "Database error deleting
    // user" on this project for hard deletes, so we delete the auth row through
    // a security-definer RPC (service-role gated) that performs the same
    // cascade-safe hard delete proven by direct SQL.
    const { data: deleted, error: deleteError } = await supabase.rpc(
      "delete_user_auth_cascade",
      { p_user_id: user.id },
    )
    if (deleteError) throw deleteError
    if (!deleted) {
      return new Response(JSON.stringify({ error: "Account could not be deleted. Please try again." }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})