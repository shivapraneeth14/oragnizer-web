import { optionalEnv, requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { safeEqual } from "../_shared/crypto.ts"
import { logError } from "../_shared/logger.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)
const SEED_ADMIN_SECRET = optionalEnv("SEED_ADMIN_SECRET")

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-seed-admin-secret",
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
    // Authorization: this endpoint can create the first admin (bootstrap) and
    // reset the admin password, so once any admin exists it must be an admin
    // making the call.
    const { data: existingAdmin, error: adminLookupErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("is_admin", true)
      .limit(1)
      .maybeSingle()

    if (adminLookupErr) {
      return new Response(JSON.stringify({ error: "Something went wrong." }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (!existingAdmin) {
      // F-5 fix (bootstrap exposure): with no admin in the system, anyone
      // could call this endpoint and create the first admin. A bootstrap
      // secret — set once in Vault and never present in the repo — is now
      // required for the no-admin path.
      const presented = req.headers.get("x-seed-admin-secret") ?? ""
      if (!SEED_ADMIN_SECRET || !safeEqual(presented, SEED_ADMIN_SECRET)) {
        return new Response(JSON.stringify({ error: "Not authorized." }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
    }

    if (existingAdmin) {
      const authHeader = req.headers.get("Authorization")
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
      const token = authHeader.slice(7)
      const { data: { user }, error: authError } = await supabase.auth.getUser(token)
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Invalid session" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
      const { data: callerProfile } = await supabase
        .from("profiles")
        .select("is_admin")
        .eq("id", user.id)
        .maybeSingle()
      if (!callerProfile?.is_admin) {
        return new Response(JSON.stringify({ error: "Only an admin can run this" }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
    }

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
        app_metadata: { cluvo_provisioned: true },
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
  } catch (err) {
    logError("seed-admin", err)
    return new Response(JSON.stringify({ error: "Something went wrong." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
