import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
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
  const rl = await checkRateLimit(ip, "create-community")
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized. Please sign in again." }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session. Please sign in again." }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: existingOwner } = await supabase
      .from("community_members")
      .select("community_id")
      .eq("user_id", user.id)
      .eq("role", "OWNER")
      .maybeSingle()

    if (existingOwner) {
      return new Response(JSON.stringify({ error: "You already own a community. Each account can only create one." }), {
        status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const {
      community_name, category, description,
      city, state, country,
      contact_email, contact_phone,
      tags, visibility, rules, agree18, agreeContent,
    } = await req.json()

    const errors: string[] = []
    const required: Array<[unknown, string]> = [
      [community_name, "Please enter a community name."],
      [category, "Please select a category."],
      [country, "Please select a country."],
      [state, "Please select a state."],
      [city, "Please select a city."],
      [contact_email, "Please enter a contact email."],
      [contact_phone, "Please enter a contact phone number."],
      [rules, "Please enter community rules."],
      [agree18, "You must confirm you are 18 years or older."],
      [agreeContent, "You must agree to the content guidelines."],
    ]
    for (const [value, message] of required) {
      const missing = typeof value === "string" ? !value.trim() : !value
      if (missing) errors.push(message)
    }

    if (errors.length > 0) {
      return new Response(JSON.stringify({ error: errors[0] }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (contact_email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(contact_email)) {
        return new Response(JSON.stringify({ error: "Please enter a valid contact email." }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }

      const { data: existingEmail } = await supabase
        .from("communities")
        .select("id")
        .eq("contact_email", contact_email.trim())
        .is("deleted_at", null)
        .maybeSingle()

      if (existingEmail) {
        return new Response(JSON.stringify({ error: "This contact email is already associated with another community." }), {
          status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
    }

    const { data: existingCommunity } = await supabase
      .from("communities")
      .select("id")
      .eq("name", community_name.trim())
      .is("deleted_at", null)
      .maybeSingle()

    if (existingCommunity) {
      return new Response(JSON.stringify({ error: "This community name is already taken. Try another." }), {
        status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { data: community, error: communityError } = await supabase
      .from("communities")
      .insert({
        name: community_name.trim(),
        description: description?.trim() || null,
        category: category?.trim() || null,
        city: city?.trim() || null,
        state: state?.trim() || null,
        country: country?.trim() || null,
        contact_email: contact_email?.trim() || null,
        contact_phone: contact_phone?.trim() || null,
        tags: Array.isArray(tags) ? tags : null,
        visibility: visibility || "public",
        rules: rules?.trim() || null,
        owner_id: user.id,
        verification_status: "unverified",
      })
      .select("id")
      .single()

    if (communityError) {
      console.error("Community creation failed:", communityError)
      return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
        status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { error: memberError } = await supabase
      .from("community_members")
      .insert({
        community_id: community.id,
        user_id: user.id,
        role: "OWNER",
      })

    if (memberError) {
      await supabase.from("communities").delete().eq("id", community.id)
      console.error("Member creation failed:", memberError)
      return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
        status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: "community_created",
      target_type: "community",
      target_id: community.id,
      details: { community_name },
    })

    return new Response(JSON.stringify({
      success: true,
      community_id: community.id,
    }), {
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
