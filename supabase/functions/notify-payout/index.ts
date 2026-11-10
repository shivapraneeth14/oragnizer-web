import { requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { sendChigzoEmail } from "../_shared/send-email.ts"
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

    // Verify user is an admin or service_role
    const { data: callerProfile } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .maybeSingle()

    if (!callerProfile?.is_admin) {
      return jsonResponse({ error: "Forbidden: Platform administrator privileges required" }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const payoutId = body?.payout_id

    if (!payoutId) {
      return jsonResponse({ error: "Missing required parameter: payout_id" }, 400)
    }

    // Fetch payout details
    const { data: payout, error: payoutErr } = await supabase
      .from("payout_items")
      .select("*, communities(id, name, owner_id), events(id, title), community_beneficiaries(*)")
      .eq("id", payoutId)
      .maybeSingle()

    if (payoutErr || !payout) {
      return jsonResponse({ error: "Payout item not found" }, 404)
    }

    const community = payout.communities
    if (!community || !community.owner_id) {
      return jsonResponse({ error: "Community or community owner not found" }, 404)
    }

    // Fetch organizer's profile (email and name)
    const { data: ownerProfile } = await supabase
      .from("profiles")
      .select("email, first_name, last_name, username")
      .eq("id", community.owner_id)
      .maybeSingle()

    if (!ownerProfile?.email) {
      return jsonResponse({ ok: true, email_sent: false, message: "Organizer has no email address configured" })
    }

    const ownerName =
      [ownerProfile.first_name, ownerProfile.last_name].filter(Boolean).join(" ") ||
      ownerProfile.username ||
      "Organizer"

    const amountRupees = (payout.amount / 100).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })

    const eventTitle = payout.events?.title
    const scopeDescription = eventTitle
      ? `Event Settlement: "${eventTitle}"`
      : "Entire Community Wallet Settlement"

    // Optional, additive: lets the admin app tailor the email to the action taken.
    // Unknown / missing context keeps the original "initiated" wording.
    const context = typeof body?.context === "string" ? body.context : "initiated"

    const payoutDetails = `Payout Details:
- Amount: ₹${amountRupees}
- Scope: ${scopeDescription}
- Transfer Method: ${payout.payment_method || "Bank Transfer"}
- Reference / UTR: ${payout.utr || "N/A"}
${payout.admin_notes ? `- Admin Note: ${payout.admin_notes}\n` : ""}`

    let subject = `[Action Required] Payout Initiated: ₹${amountRupees} for ${community.name}`

    let textBody = `Hello ${ownerName},

A manual payout of ₹${amountRupees} has been initiated for your community "${community.name}".

${payoutDetails}- Status: Pending Your Digital Confirmation

Next Steps:
Please sign in to your Chigzo Organizer Portal to review and confirm receipt of these funds.
Once accepted, this amount will be reconciled with your community wallet and recorded as settled.

If you have any questions or notice an issue with this transfer, you can flag it directly by selecting "Report Issue / Dispute" inside your Organizer Portal.

Warm regards,
The Chigzo Team`

    if (context === "verified") {
      subject = `[Settled] Payout of ₹${amountRupees} marked received for ${community.name}`
      textBody = `Hello ${ownerName},

We verified the manual payout below against the bank statement and marked it as received.

${payoutDetails}- Status: Settled / Received

No further action is required. This amount is now recorded as paid out from your community wallet.

Warm regards,
The Chigzo Team`
    } else if (context === "reconfirmed") {
      subject = `[Action Required] Please re-confirm payout of ₹${amountRupees} for ${community.name}`
      textBody = `Hello ${ownerName},

We re-checked the settlement below with the bank and believe it was delivered to your account. Please review it and confirm receipt.

${payoutDetails}- Status: Pending Your Digital Confirmation

Next Steps:
Sign in to your Chigzo Organizer Portal and confirm receipt. If the funds still have not arrived, select "Report Issue / Dispute" again and attach your bank statement.

Warm regards,
The Chigzo Team`
    } else if (context === "reissued") {
      subject = `[Action Required] Payout reissued: ₹${amountRupees} for ${community.name}`
      textBody = `Hello ${ownerName},

The earlier transfer could not be completed, so we reissued the payout below with a new bank reference.

${payoutDetails}- Status: Pending Your Digital Confirmation

Next Steps:
Please sign in to your Chigzo Organizer Portal to review and confirm receipt of these funds.

Warm regards,
The Chigzo Team`
    }

    try {
      await sendChigzoEmail(ownerProfile.email, subject, textBody)
      return jsonResponse({ ok: true, email_sent: true, recipient: ownerProfile.email })
    } catch (emailErr) {
      logError("notify-payout sendChigzoEmail failed:", emailErr)
      // Return ok: true so caller doesn't fail the recorded transaction, but note email_sent: false
      return jsonResponse({ ok: true, email_sent: false, error: "SMTP delivery failed" })
    }
  } catch (err: any) {
    logError("notify-payout handler error:", err)
    return jsonResponse({ error: err?.message || "Internal server error" }, 500)
  }
})

