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

  const ip = getClientIp(req)
  const rl = await checkRateLimit(ip, "register")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  try {
    const { email, password, first_name, last_name, username } = await req.json()

    const errors: string[] = []
    if (!email || typeof email !== "string") errors.push("Please enter your email address.")
    if (!password || typeof password !== "string") errors.push("Please enter a password.")
    if (!first_name || typeof first_name !== "string") errors.push("Please enter your first name.")
    if (!last_name || typeof last_name !== "string") errors.push("Please enter your last name.")
    if (!username || typeof username !== "string") errors.push("Please enter a username.")

    if (errors.length > 0) {
      return new Response(JSON.stringify({ error: errors[0] }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email.trim())) {
      return new Response(JSON.stringify({ error: "Please enter a valid email address." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (password.length < 8) {
      return new Response(JSON.stringify({ error: "Password must be at least 8 characters." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (!/[A-Z]/.test(password)) {
      return new Response(JSON.stringify({ error: "Password needs at least one capital letter." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: existingUser } = await supabase
      .from("profiles")
      .select("id")
      .eq("username", username.trim())
      .is("deleted_at", null)
      .maybeSingle()

    if (existingUser) {
      return new Response(JSON.stringify({ error: "This username is already taken. Try another." }), {
        status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: existingEmail } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", email.trim().toLowerCase())
      .maybeSingle()

    if (existingEmail) {
      return new Response(JSON.stringify({ error: "An account with this email already exists." }), {
        status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true,
      user_metadata: {
        first_name: first_name.trim(),
        last_name: last_name.trim(),
        username: username.trim(),
      },
    })

    if (authError) {
      if (authError.message.includes("already registered")) {
        return new Response(JSON.stringify({ error: "An account with this email already exists." }), {
          status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
      throw authError
    }

    await supabase.from("audit_log").insert({
      actor_id: authData.user!.id,
      action: "user_registered",
      target_type: "user",
      target_id: authData.user!.id,
      details: { email: email.trim().toLowerCase() },
    })

    return new Response(JSON.stringify({ success: true, user_id: authData.user!.id }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
