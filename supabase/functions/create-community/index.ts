import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { isDeletionPending, deletionPendingResponse } from "../_shared/deletion.ts"
import { sendCluvoEmail } from "../_shared/send-email.ts"
import { logError } from "../_shared/logger.ts"

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

    // Check if user already has a pending application under review
    const { data: pendingApp } = await supabase
      .from("community_applications")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .maybeSingle()

    if (pendingApp) {
      return new Response(JSON.stringify({ error: "You already have a community application under review." }), {
        status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (await isDeletionPending(supabase, user.id)) return deletionPendingResponse()

    const {
      community_name, category, description,
      city, state, country,
      contact_email, contact_phone,
      tags, rules, agree18, agreeContent,
    } = await req.json()

    const errors: string[] = []
    const required: Array<[unknown, string]> = [
      [community_name, "Please enter a community name."],
      [category, "Please select a category."],
      [description, "Please enter a community description."],
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

    const tooLong = (v: unknown, max: number) => typeof v === "string" && v.length > max
    const lengthChecks: Array<[unknown, number, string]> = [
      [community_name, 100, "Community name is too long (max 100 characters)."],
      [description, 2000, "Description is too long (max 2000 characters)."],
      [rules, 4000, "Community rules are too long (max 4000 characters)."],
      [contact_phone, 32, "Contact phone number is too long."],
    ]
    for (const [value, max, message] of lengthChecks) {
      if (tooLong(value, max)) {
        return new Response(JSON.stringify({ error: message }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
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

      const { data: pendingEmail } = await supabase
        .from("community_applications")
        .select("id")
        .ilike("contact_email", contact_email.trim())
        .eq("status", "pending")
        .maybeSingle()

      if (pendingEmail) {
        return new Response(JSON.stringify({ error: "This contact email is already associated with a pending community application." }), {
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

    const { data: pendingName } = await supabase
      .from("community_applications")
      .select("id")
      .ilike("community_name", community_name.trim())
      .eq("status", "pending")
      .maybeSingle()

    if (pendingName) {
      return new Response(JSON.stringify({ error: "This community name is already taken. Try another." }), {
        status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Check if user previously had a rejected application to update, or insert fresh
    const { data: existingRejected } = await supabase
      .from("community_applications")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "rejected")
      .maybeSingle()

    let applicationId: string

    // Private communities are retired: always public, regardless of what the caller sends.
    const _visibilityEnforce = { visibility: "public" }

    if (existingRejected) {
      const { data: updatedApp, error: updateErr } = await supabase
        .from("community_applications")
        .update({
          community_name: community_name.trim(),
          description: description.trim(),
          category: category?.trim() || null,
          city: city?.trim() || null,
          state: state?.trim() || null,
          country: country?.trim() || null,
          contact_email: contact_email?.trim() || null,
          contact_phone: contact_phone?.trim() || null,
          tags: Array.isArray(tags) ? tags : [],
          rules: rules?.trim() || null,
          status: "pending",
          rejection_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingRejected.id)
        .select("id")
        .single()

      if (updateErr) {
        logError("create-community update rejected app", updateErr)
        return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
      applicationId = updatedApp.id
    } else {
      const { data: newApp, error: appError } = await supabase
        .from("community_applications")
        .insert({
          user_id: user.id,
          community_name: community_name.trim(),
          description: description.trim(),
          category: category?.trim() || null,
          city: city?.trim() || null,
          state: state?.trim() || null,
          country: country?.trim() || null,
          contact_email: contact_email?.trim() || null,
          contact_phone: contact_phone?.trim() || null,
          tags: Array.isArray(tags) ? tags : [],
          rules: rules?.trim() || null,
          status: "pending",
        })
        .select("id")
        .single()

      if (appError) {
        logError("create-community insert application", appError)
        return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
      applicationId = newApp.id
    }

    await supabase.from("audit_log").insert({
      actor_id: user.id,
      action: "community_application_submitted",
      target_type: "community_application",
      target_id: applicationId,
      details: { community_name, visibility: _visibilityEnforce.visibility },
    })

    // Asynchronously dispatch confirmation email to applicant if email configured
    if (user.email) {
      const subject = `Community Submitted for Review: "${community_name.trim()}"`
      const body = `Hello,

Thank you for creating "${community_name.trim()}" on Cluvo.

Your community application has been submitted to the admin team for review and verification.
Once verified and approved, your community will be activated and you will gain full access to your Organizer Dashboard.

Submission Summary:
- Community: ${community_name.trim()}
- Location: ${city.trim()}, ${country.trim()}
- Contact Email: ${contact_email.trim()}
- Contact Phone: ${contact_phone.trim()}

You can log in to your Cluvo Organizer Portal at any time to check the live status of your application.

Warm regards,
The Cluvo Team`

      sendCluvoEmail(user.email, subject, body).catch((e) => {
        logError("create-community confirmation email error", e)
      })
    }

    return new Response(JSON.stringify({
      success: true,
      pending: true,
      application_id: applicationId,
      message: "Your community has been submitted for review. Please wait for verification.",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    logError("create-community", err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
