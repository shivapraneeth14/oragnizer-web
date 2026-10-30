import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { sendCluvoEmail } from "../_shared/send-email.ts"
import { logError } from "../_shared/logger.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
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

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "Unauthorized: Missing access token" }, 401)
    }

    const token = authHeader.slice(7)
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(token)

    if (userErr || !user) {
      return jsonResponse({ error: "Unauthorized: Invalid session" }, 401)
    }

    // Verify user is an admin
    const { data: callerProfile } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .maybeSingle()

    if (!callerProfile?.is_admin) {
      return jsonResponse({ error: "Forbidden: Platform administrator privileges required" }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const { application_id, action, reason } = body

    if (!application_id || !action) {
      return jsonResponse({ error: "Missing required parameters: application_id, action" }, 400)
    }

    const { data: app, error: appErr } = await supabase
      .from("community_applications")
      .select("*, profiles!community_applications_user_id_fkey(email, first_name, last_name, username)")
      .eq("id", application_id)
      .maybeSingle()

    if (appErr || !app) {
      return jsonResponse({ error: "Application not found" }, 404)
    }

    const profile = (app as any).profiles
    const recipientEmail = profile?.email || app.contact_email
    if (!recipientEmail) {
      return jsonResponse({ ok: true, email_sent: false, message: "No email address found for applicant" })
    }

    const applicantName =
      [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
      profile?.username ||
      "Organizer"

    let subject = ""
    let textBody = ""

    if (action === "approved") {
      subject = `🎉 Community Approved: Welcome to Cluvo, ${app.community_name}!`
      textBody = `Hello ${applicantName},

Congratulations! Your community "${app.community_name}" has been approved and activated by the Cluvo team.

Your community is now live, visible in discovery, and you have full access to your Organizer Dashboard. You can now publish events, build your community membership, and manage revenue.

Next steps:
Log in to your Cluvo Organizer Portal to start setting up your first event!

Warm regards,
The Cluvo Team`
    } else {
      subject = `Update on your Cluvo Community Application: ${app.community_name}`
      textBody = `Hello ${applicantName},

Thank you for your interest in creating "${app.community_name}" on Cluvo.
Our verification team has reviewed your application.

Feedback from our team:
${reason || app.rejection_reason || "Your application did not meet our verification criteria at this time."}

Next steps:
You can log in to your Cluvo Organizer Portal at any time to revise the required information and re-submit your application for review.

Warm regards,
The Cluvo Team`
    }

    try {
      await sendCluvoEmail(recipientEmail, subject, textBody)
      return jsonResponse({ ok: true, email_sent: true, recipient: recipientEmail })
    } catch (emailErr) {
      logError("notify-community-approval email delivery error:", emailErr)
      return jsonResponse({ ok: true, email_sent: false, error: "SMTP delivery failed" })
    }
  } catch (err: any) {
    logError("notify-community-approval handler error:", err)
    return jsonResponse({ error: err?.message || "Internal server error" }, 500)
  }
})

