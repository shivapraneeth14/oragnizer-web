import type { SupabaseClient } from "jsr:@supabase/supabase-js@2"

// Shared helpers for the 30-day grace-period deletion model.
//
// GRACE_DAYS is the number of days between a deletion request and the
// permanent purge. Set once; the purge job reads the same value.

export const GRACE_DAYS = 30

const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000

// The instant at which a grace period that started at `startedAt` expires.
export function graceDueAt(startedAt: string | Date): Date {
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt)
  return new Date(start.getTime() + GRACE_MS)
}

// True when a grace period that started at `startedAt` has fully elapsed.
export function isGraceExpired(
  startedAt: string | Date,
  now: Date = new Date(),
): boolean {
  return now.getTime() - graceDueAt(startedAt).getTime() >= 0
}

// Extract a Cloudinary public_id from a stored avatar URL.
// URL shape: https://res.cloudinary.com/<cloud>/image/upload/v123/<public_id>.<ext>
// Returns null for blank/non-Cloudinary URLs. The public_id is an opaque
// token (no user identity), so storing it for deferred cleanup is safe.
export function cloudinaryPublicId(url: string | null): string | null {
  if (!url) return null
  const m = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?$/)
  return m?.[1] ?? null
}

export const DELETION_PENDING_MESSAGE =
  "Your account is scheduled for permanent deletion. You can restore it by logging in and choosing \"Keep my account\"."

// Check whether a user has an active deletion grace period.
// Returns the grace start timestamp, or null if not in grace.
export async function getDeletionGrace(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("profiles")
    .select("deletion_grace_started_at")
    .eq("id", userId)
    .maybeSingle()
  return data?.deletion_grace_started_at ?? null
}

// Returns true if the user is currently in a deletion grace period.
export async function isDeletionPending(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  return (await getDeletionGrace(supabase, userId)) !== null
}

// Standard 409 response for actions blocked by an active deletion grace.
export function deletionPendingResponse(): Response {
  return new Response(
    JSON.stringify({
      error: DELETION_PENDING_MESSAGE,
      deletion_grace: true,
    }),
    {
      status: 409,
      headers: { "Content-Type": "application/json" },
    },
  )
}

// Standard 403 response for organizer-gated actions when grace is active.
// Distinct from the suspension message so the client can show the right UI.
export function deletionGraceForbiddenResponse(): Response {
  return new Response(
    JSON.stringify({
      error: DELETION_PENDING_MESSAGE,
      deletion_grace: true,
    }),
    {
      status: 403,
      headers: { "Content-Type": "application/json" },
    },
  )
}
