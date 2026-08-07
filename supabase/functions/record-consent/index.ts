import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { CONSENT_VERSION, isValidConsentSource } from "../_shared/consent.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  })
}

function bearerToken(req: Request): string {
  const header = req.headers.get("Authorization") ?? ""
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })

  const jwt = bearerToken(req)
  if (!jwt) return json({ error: "Missing bearer token." }, 401)

  const { data: userData, error: userError } = await supabase.auth.getUser(jwt)
  if (userError || !userData.user) {
    return json({ error: "Invalid or expired token." }, 401)
  }
  const user = userData.user

  // GET — consent status for the current user. Used by clients after OAuth
  // to decide whether the consent gate must be shown.
  if (req.method === "GET") {
    const { data } = await supabase
      .from("consent_log")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle()
    return json({ consent: !!data })
  }

  // POST — record consent for the current user (Google/OAuth-created accounts).
  // Idempotent: never writes a second row if one already exists.
  if (req.method === "POST") {
    let body: Record<string, unknown> = {}
    try {
      body = await req.json()
    } catch {
      // empty body allowed — defaults apply
    }
    // NOTE: only "source" is read from the client. accepted_at comes from the
    // column default (now()); consent_version is the server constant.
    const source = isValidConsentSource(body.source) ? body.source : "mobile"

    const { data: existing } = await supabase
      .from("consent_log")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle()
    if (existing) return json({ created: false, consent: true })

    const { error: insertError } = await supabase.from("consent_log").insert({
      user_id: user.id,
      consent_version: CONSENT_VERSION,
      source,
    })
    if (insertError) {
      console.error(insertError)
      return json({ error: "Could not record consent." }, 500)
    }
    return json({ created: true, consent: true })
  }

  return json({ error: "Method not allowed" }, 405)
})
