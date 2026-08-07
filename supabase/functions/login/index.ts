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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  const ip = getClientIp(req)
  const rl = await checkRateLimit(ip, "login")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  try {
    const { email, password } = await req.json()
    if (typeof email !== "string" || email.trim() === "") {
      return jsonResponse({ error: "Please enter your email address." }, 400)
    }
    if (typeof password !== "string" || password === "") {
      return jsonResponse({ error: "Please enter your password." }, 400)
    }

    const { data, error } = await anonClient.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (error) {
      return jsonResponse({ error: error.message }, 400)
    }

    const user = data.user
    if (!user) {
      return jsonResponse({ error: "Something went wrong. Try again." }, 500)
    }

    // Organizer gate: only users who own a community (or platform admins) may
    // use the organizer web. The session is revoked server-side so a
    // community-less user never leaves with a usable token.
    const isOrganizer = await isOrganizerAccount(supabase, user.id)
    if (!isOrganizer) {
      await supabase.auth.admin.signOut(data.session.access_token)
      return jsonResponse({ error: NOT_ORGANIZER_MESSAGE }, 403)
    }

    return jsonResponse({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: Math.floor(data.session.expires_at ?? 0),
      token_type: "bearer",
    })
  } catch (err) {
    console.error(err)
    return jsonResponse({ error: "Something went wrong. Try again." }, 500)
  }
})
