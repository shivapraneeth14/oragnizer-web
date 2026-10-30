import { optionalEnv, requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const RECONCILE_SECRET = optionalEnv("RECONCILE_SECRET")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
}

// ============================================================================
// CLUVO — STAGE 5 MILESTONE B: DURABLE EVENT CANCELLATION
//
// Fast asynchronous cancellation:
// 1. Authenticates caller & validates rate limits (< 15ms).
// 2. Invokes atomic cancel_event_and_enqueue_refunds RPC (< 50ms):
//    - Freezes event (status = 'cancelling').
//    - Creates master cancellation job.
//    - Enqueues all attendee refund/cancellation tasks into durable queue.
// 3. Dispatches background worker via EdgeRuntime.waitUntil.
// 4. Returns HTTP 202 Accepted immediately with job metadata.
// ============================================================================

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
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const rl = await checkRateLimit(user.id, "cancel-event")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { event_id } = await req.json()
    if (!event_id) {
      return new Response(JSON.stringify({ error: "Event ID required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Atomic freeze, job creation, and task enqueue
    const { data: result, error: enqueueErr } = await supabase.rpc(
      "cancel_event_and_enqueue_refunds",
      {
        p_event_id: event_id,
        p_caller_id: user.id,
      },
    )

    if (enqueueErr) {
      console.error("Cancel event RPC error:", enqueueErr)
      return new Response(JSON.stringify({ error: enqueueErr.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (result?.error) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: result.code || 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Dispatch background worker (non-blocking)
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseServiceKey}`,
      }
      if (RECONCILE_SECRET) {
        headers["x-worker-secret"] = RECONCILE_SECRET
      }

      // @ts-ignore: EdgeRuntime available in Supabase Edge Functions
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(
          fetch(`${supabaseUrl}/functions/v1/process-cancellation-queue`, {
            method: "POST",
            headers,
            body: JSON.stringify({ job_id: result.job_id }),
          }).catch((err) => console.error("Worker trigger failed:", err)),
        )
      } else {
        // Fallback for non-EdgeRuntime (e.g. standard tests)
        fetch(`${supabaseUrl}/functions/v1/process-cancellation-queue`, {
          method: "POST",
          headers,
          body: JSON.stringify({ job_id: result.job_id }),
        }).catch(() => {})
      }
    } catch (dispatchErr) {
      console.warn("Could not dispatch background worker immediately:", dispatchErr)
    }

    return new Response(
      JSON.stringify({
        success: true,
        status: "cancelling",
        job_id: result.job_id,
        total_registrations: result.total_registrations,
        total_refunds_eligible: result.total_refunds_eligible,
        skipped_attended: result.skipped_attended,
        message: "Event cancellation initiated. Refunds are being processed asynchronously.",
      }),
      {
        status: 202,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    )
  } catch (err: any) {
    console.error("Cancel-event handler error:", err)
    return new Response(JSON.stringify({ error: "Something went wrong. Try again." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})
