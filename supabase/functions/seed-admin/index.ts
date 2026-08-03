import { optionalEnv, requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
  const rl = await checkRateLimit(ip, "seed-admin")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  try {
    const adminEmail = optionalEnv("ADMIN_EMAIL")
    const adminPassword = optionalEnv("ADMIN_PASSWORD")

    if (!adminEmail || !adminPassword) {
      return new Response(JSON.stringify({ error: "Admin credentials not configured." }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: existingUsers } = await supabase.auth.admin.listUsers()
    const existing = existingUsers?.users.find((u) => u.email === adminEmail)

    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, { password: adminPassword })
      await supabase.from("profiles").update({ is_admin: true }).eq("id", existing.id)
    } else {
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email: adminEmail,
        password: adminPassword,
        email_confirm: true,
        user_metadata: { first_name: "Admin", last_name: "User", username: "admin" },
      })

      if (createError || !newUser.user) {
        return new Response(JSON.stringify({ error: "Failed to create admin user." }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }

      await supabase.from("profiles").update({ is_admin: true }).eq("id", newUser.user.id)
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch {
    return new Response(JSON.stringify({ error: "Something went wrong." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
