import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)
const anonClient = createClient(supabaseUrl, requiredEnv("SUPABASE_ANON_KEY"))

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
}

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  })

async function isOrganizerAccount(userId: string): Promise<boolean> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle()
  if (profile?.is_admin === true) return true

  const { data: community } = await supabase
    .from("communities")
    .select("id")
    .eq("owner_id", userId)
    .is("deleted_at", null)
    .maybeSingle()
  if (community) return true

  const { data: membership } = await supabase
    .from("community_members")
    .select("id")
    .eq("user_id", userId)
    .in("role", ["ORGANIZER", "OWNER"])
    .maybeSingle()
  return membership !== null
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  const ip = getClientIp(req)
  const rl = await checkRateLimit(ip, "forgot-password")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  try {
    const { email, redirectTo, requireOrganizer } = await req.json()

    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return jsonResponse({ error: "Please enter a valid email address." }, 400)
    }
    if (typeof redirectTo !== "string" || redirectTo.length > 500) {
      return jsonResponse({ error: "Invalid redirect target." }, 400)
    }

    const normalizedEmail = email.trim().toLowerCase()

    const { data: userList, error: listError } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    })
    if (listError) throw listError
    if (!userList?.users) throw new Error("User lookup returned no data")

    const user = userList.users.find((u) => (u.email ?? "").toLowerCase() === normalizedEmail)
    if (!user) {
      return jsonResponse({ kind: "none", sent: false })
    }

    const { data: userResult, error: userError } = await supabase.auth.admin.getUserById(user.id)
    if (userError) throw userError

    const providers = (userResult.user?.identities ?? []).map((identity) => identity.provider)
    const hasEmailIdentity = providers.includes("email")
    const hasGoogleIdentity = providers.includes("google")

    if (!hasEmailIdentity) {
      return jsonResponse({ kind: hasGoogleIdentity ? "google" : "none", sent: false })
    }

    if (requireOrganizer === true) {
      const isOrganizer = await isOrganizerAccount(user.id)
      if (!isOrganizer) {
        return jsonResponse({ kind: "none", sent: false })
      }
    }

    const { error: recoverError } = await anonClient.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo,
    })
    if (recoverError) {
      if (recoverError.message.toLowerCase().includes("rate limit")) {
        return jsonResponse(
          { error: "Too many requests. Please wait a few minutes and try again." },
          429,
        )
      }
      throw recoverError
    }

    return jsonResponse({ kind: hasGoogleIdentity ? "both" : "password", sent: true })
  } catch (err) {
    console.error(err)
    return jsonResponse({ error: "Something went wrong. Try again." }, 500)
  }
})
