import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { isOrganizerAccount, NOT_ORGANIZER_MESSAGE } from "../_shared/organizer.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabaseAnonKey = requiredEnv("SUPABASE_ANON_KEY")
const anonClient = createClient(supabaseUrl, supabaseAnonKey)
const supabase = createClient(supabaseUrl, supabaseServiceKey)

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

function isGoogleIdentity(user: { app_metadata?: Record<string, unknown>; identities?: Array<{ provider: string }> | null }): boolean {
  return (
    user.app_metadata?.provider === "google" ||
    (Array.isArray(user.identities) && user.identities.some((i) => i.provider === "google"))
  )
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  const ip = getClientIp(req)
  const rl = await checkRateLimit(ip, "check-organizer")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  try {
    const authHeader = req.headers.get("Authorization") ?? ""
    const token = authHeader.replace(/^Bearer\s+/i, "").trim()
    if (!token) {
      return jsonResponse({ error: "Missing session token." }, 401)
    }

    const { data, error } = await anonClient.auth.getUser(token)
    if (error || !data.user) {
      return jsonResponse({ error: "Invalid or expired session." }, 401)
    }

    const user = data.user
    // Google identities are exempt from the organizer check — Google sign-in
    // is the public signup path for new organizers.
    if (isGoogleIdentity(user)) {
      return jsonResponse({ organizer: true, exempt: true })
    }

    const organizer = await isOrganizerAccount(supabase, user.id)
    return organizer
      ? jsonResponse({ organizer: true })
      : jsonResponse({ organizer: false, message: NOT_ORGANIZER_MESSAGE })
  } catch (err) {
    console.error(err)
    return jsonResponse({ error: "Something went wrong. Try again." }, 500)
  }
})
