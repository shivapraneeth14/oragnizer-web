import { optionalEnv, requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts"
import { cashfreeGet } from "../_shared/cashfree.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const PAYOUT_SYNC_SECRET = optionalEnv("PAYOUT_SYNC_SECRET")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const STUCK_AFTER_MS = 3 * 60 * 1000
const TERMINAL_FAIL = ["FAILED", "REJECTED", "REVERSED", "CANCELLED"]

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-sync-secret, apikey",
  "Access-Control-Max-Age": "86400",
}

interface PayoutRow {
  id: string
  status: string
  community_id: string
  amounts?: number
}

// Ask Cashfree for the authoritative status of one payout and apply it via
// the guarded RPC (idempotent: never refunds twice).
async function checkTransfer(id: string, cfRef?: string | null): Promise<Record<string, unknown>> {
  const transferId = `wd_${id.replace(/-/g, "")}`
  let check: Record<string, any>
  try {
    check = await cashfreeGet(`/getTransferStatus?transferId=${encodeURIComponent(transferId)}`)
  } catch (firstErr) {
    // Fallback: look up by Cashfree's own reference id.
    if (!cfRef) {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr)
      return { payout_id: id, checked: false, error: msg }
    }
    try {
      check = await cashfreeGet(`/getTransferStatus?referenceId=${encodeURIComponent(cfRef)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`status check failed for ${id}:`, msg)
      return { payout_id: id, checked: false, error: msg }
    }
  }

  // Defensive unwrap: v1.2 returns data.transfer, some responses put it flat.
  const inner = check?.data?.transfer ?? check?.data ?? check ?? {}
  const cashfreeStatus = inner?.status ?? null
  const utr = inner?.utr ?? null
  const reason = inner?.failure_reason ?? inner?.statusDescription ?? check?.message ?? null

  if (!cashfreeStatus) {
    return { payout_id: id, checked: false, error: "No status in Cashfree response" }
  }

  const { data: applied, error: rpcErr } = await supabase.rpc("sync_payout_status_update", {
    p_payout_id: id,
    p_cashfree_status: cashfreeStatus,
    p_utr: typeof utr === "string" ? utr : null,
    p_status_reason: typeof reason === "string" ? reason : null,
  })

  if (rpcErr) {
    console.error(`RPC failed for ${id}:`, rpcErr)
    return { payout_id: id, checked: false, error: rpcErr.message }
  }

  return { payout_id: id, checked: true, cashfree_status: cashfreeStatus, result: applied ?? null }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })

  try {
    const url = new URL(req.url)
    const results: Record<string, unknown>[] = []

    // Mode 1: cron (pg_cron) — internal secret header, full scan of stuck rows.
    if (req.headers.get("x-sync-secret") === PAYOUT_SYNC_SECRET) {
      const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS).toISOString()
      const { data: rows, error } = await supabase
        .from("payout_items")
        .select("id, status, community_id, cashfree_payout_id")
        .in("status", ["processing", "in_progress"])
        .lt("created_at", stuckBefore)
        .limit(50)

      if (error) throw error

      for (const row of rows ?? []) {
        results.push(await checkTransfer(row.id, row.cashfree_payout_id))
      }

      return new Response(JSON.stringify({ mode: "cron", checked: results.length, results }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    // Mode 2: on-demand — organizer JWT, force-check a single payout.
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const rl = await checkRateLimit(user.id, "sync-payout-status")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const payoutId = url.searchParams.get("payout_id")
    if (!payoutId) return new Response(JSON.stringify({ error: "payout_id query param is required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: payout, error: payoutErr } = await supabase
      .from("payout_items")
      .select("id, status, community_id, cashfree_payout_id")
      .eq("id", payoutId)
      .maybeSingle()

    if (payoutErr) throw payoutErr
    if (!payout) return new Response(JSON.stringify({ error: "Payout not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const { data: community } = await supabase
      .from("communities")
      .select("owner_id")
      .eq("id", payout.community_id)
      .single()

    if (!community || community.owner_id !== user.id) {
      return new Response(JSON.stringify({ error: "Only the community owner can check this payout" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    results.push(await checkTransfer(payoutId, payout.cashfree_payout_id))

    return new Response(JSON.stringify({ mode: "manual", results }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    console.error(err)
    const msg = err instanceof Error ? err.message : "Something went wrong"
    return new Response(JSON.stringify({ error: msg }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})