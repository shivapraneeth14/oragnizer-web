import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

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

    const { data: community } = await supabase
      .from("communities")
      .select("id, name")
      .eq("owner_id", user.id)
      .is("deleted_at", null)
      .maybeSingle()

    if (!community) {
      return new Response(JSON.stringify({ error: "You don't own a community." }), {
        status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const {
      name, description, category,
      city, state, country,
      contact_email, contact_phone,
      visibility, banner_url,
      instagram_url, facebook_url, twitter_url, linkedin_url,
    } = await req.json()

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return new Response(JSON.stringify({ error: "Community name is required." }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
      if (name.trim() !== community.name) {
        const { data: existing } = await supabase
          .from("communities")
          .select("id")
          .eq("name", name.trim())
          .is("deleted_at", null)
          .neq("id", community.id)
          .maybeSingle()
        if (existing) {
          return new Response(JSON.stringify({ error: "This community name is already taken." }), {
            status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        }
      }
    }

    if (contact_email !== undefined) {
      if (contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) {
        return new Response(JSON.stringify({ error: "Please enter a valid contact email." }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
      if (contact_email) {
        const { data: existingEmail } = await supabase
          .from("communities")
          .select("id")
          .eq("contact_email", contact_email.trim())
          .is("deleted_at", null)
          .neq("id", community.id)
          .maybeSingle()
        if (existingEmail) {
          return new Response(JSON.stringify({ error: "This contact email is already associated with another community." }), {
            status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        }
      }
    }

    if (visibility !== undefined && !["public", "private"].includes(visibility)) {
      return new Response(JSON.stringify({ error: "Visibility must be public or private." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const socialFields: Record<string, string | undefined> = { instagram_url, facebook_url, twitter_url, linkedin_url }
    for (const [key, value] of Object.entries(socialFields)) {
      if (value !== undefined && value !== null && value !== "") {
        try {
          const parsed = new URL(value)
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return new Response(JSON.stringify({ error: `${key} must be a valid http/https URL.` }), {
              status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
            })
          }
        } catch {
          return new Response(JSON.stringify({ error: `${key} is not a valid URL.` }), {
            status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        }
      }
    }

    const updates: Record<string, unknown> = {}
    if (name !== undefined) updates.name = name.trim()
    if (description !== undefined) updates.description = description?.trim() || null
    if (category !== undefined) updates.category = category?.trim() || null
    if (city !== undefined) updates.city = city?.trim() || null
    if (state !== undefined) updates.state = state?.trim() || null
    if (country !== undefined) updates.country = country?.trim() || null
    if (contact_email !== undefined) updates.contact_email = contact_email?.trim() || null
    if (contact_phone !== undefined) updates.contact_phone = contact_phone?.trim() || null
    if (visibility !== undefined) updates.visibility = visibility
    if (banner_url !== undefined) updates.banner_url = banner_url?.trim() || null
    if (instagram_url !== undefined) updates.instagram_url = instagram_url?.trim() || null
    if (facebook_url !== undefined) updates.facebook_url = facebook_url?.trim() || null
    if (twitter_url !== undefined) updates.twitter_url = twitter_url?.trim() || null
    if (linkedin_url !== undefined) updates.linkedin_url = linkedin_url?.trim() || null

    if (Object.keys(updates).length === 0) {
      return new Response(JSON.stringify({ error: "No fields to update." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const { error: updateError } = await supabase
      .from("communities")
      .update(updates)
      .eq("id", community.id)

    if (updateError) {
      console.error("Community update failed:", updateError)
      return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
        status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    return new Response(JSON.stringify({ success: true }), {
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
