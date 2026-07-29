import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID")!
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET")!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
}

async function razorpayPost(path: string, body: any) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error?.description || "Razorpay API error")
    }
    return await res.json()
  } finally {
    clearTimeout(timeout)
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const token = authHeader.replace("Bearer ", "")
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const rl = await checkRateLimit(user.id, "onboard-razorpay-account")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { community_id, account_holder, ifsc, account_number, pan } = await req.json()
    if (!community_id || !account_holder || !ifsc || !account_number || !pan) {
      return new Response(JSON.stringify({ error: "All fields are required: account_holder, ifsc, account_number, pan" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    // Verify ownership
    const { data: membership } = await supabase
      .from("community_members")
      .select("role")
      .eq("community_id", community_id)
      .eq("user_id", user.id)
      .maybeSingle()

    if (!membership || membership.role !== "OWNER") {
      return new Response(JSON.stringify({ error: "Only the community owner can set up payouts" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    // Get community name
    const { data: community } = await supabase
      .from("communities")
      .select("name")
      .eq("id", community_id)
      .single()

    // Step 1: Create Razorpay Contact
    const contact = await razorpayPost("contacts", {
      name: account_holder,
      email: user.email,
      type: "vendor",
    })

    // Step 2: Create Fund Account (bank account)
    const fundAccount = await razorpayPost("fund_accounts", {
      contact_id: contact.id,
      account_type: "bank_account",
      bank_account: {
        name: account_holder,
        ifsc,
        account_number,
      },
    })

    // Step 3: Store on profiles
    await supabase.from("profiles").update({
      razorpay_contact_id: contact.id,
      razorpay_fund_account_id: fundAccount.id,
      bank_account_holder: account_holder,
      bank_ifsc: ifsc,
      bank_account_number: account_number,
      pan,
      kyc_status: "pending",
    }).eq("id", user.id)

    // Step 4: Store linked account on community
    await supabase.from("communities").update({
      razorpay_account_id: fundAccount.id,
      razorpay_account_status: "pending",
    }).eq("id", community_id)

    // Audit log
    await supabase.from("payment_audit_log").insert({
      action: "account_onboarded",
      details: {
        community_id,
        contact_id: contact.id,
        fund_account_id: fundAccount.id,
        account_holder,
      },
    })

    return new Response(JSON.stringify({
      success: true,
      contact_id: contact.id,
      fund_account_id: fundAccount.id,
      status: "pending",
    }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err: any) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message || "Something went wrong" }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})
