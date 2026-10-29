import type { SupabaseClient } from "jsr:@supabase/supabase-js@2"

// Best-effort alert recording for background jobs.
//
// Contract:
//   - NEVER throws. A failure here must not affect the job that called it.
//   - Deduplicates: a title that is already open/acknowledged (within the last
//     10 minutes) is not inserted again, so 3-5 minute crons don't flood.
//   - Uses the caller's own (service-role) supabase client; no new env or creds.

export interface AlertInput {
  severity: "info" | "warning" | "critical"
  category: "ops" | "payout" | "payment" | "auth" | "community"
  title: string
  details?: Record<string, unknown>
  // Optional stable key that scopes dedupe to one entity (e.g. one payment).
  // Without it dedupe stays title-wide, exactly as before, so callers that do
  // not pass it keep their current behaviour.
  dedupeKey?: string
}

const DEDUPE_WINDOW_MS = 10 * 60 * 1000

export async function recordAlert(
  supabase: SupabaseClient,
  input: AlertInput,
): Promise<void> {
  try {
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()
    let query = supabase
      .from("admin_alerts")
      .select("id")
      .eq("title", input.title)
      .in("status", ["open", "acknowledged"])
      .gte("created_at", since)

    // A title-only dedupe hides distinct entities behind one alert (every
    // refund failure shared one title). A dedupeKey narrows it to one entity.
    if (input.dedupeKey) {
      query = query.eq("details->>dedupe_key", input.dedupeKey)
    }

    const { data: existing } = await query.limit(1)

    // Same problem already visible — keep the original, just refresh nothing.
    if (existing && existing.length > 0) return

    const details = input.dedupeKey
      ? { ...(input.details ?? {}), dedupe_key: input.dedupeKey }
      : input.details ?? null

    const { error } = await supabase.from("admin_alerts").insert({
      severity: input.severity,
      category: input.category,
      title: input.title,
      details,
    })
    if (error) console.error("[alerts] insert failed:", error.message)
  } catch (err) {
    console.error("[alerts] recordAlert failed:", err)
  }
}