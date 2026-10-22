// Current policy version users are asked to agree to.
// Bump this string when the Privacy Policy / Terms of Service content
// changes so existing consent rows keep their original version (immutable
// history) while new signups record the new version. Keep in sync with:
//   apps/mobile/lib/legal_content.dart (consentVersion)
//   apps/organizer-web/src/legal/consent-version.ts
export const CONSENT_VERSION = "2026-10-22"

export function isValidConsentSource(source: unknown): source is "mobile" | "web" {
  return source === "mobile" || source === "web"
}

// True when the user has AT LEAST ONE consent row (any version). Used by
// transactional edge functions (payments, registration) as a server-side
// backstop: you cannot spend money or book without a recorded consent.
// Re-prompting for a NEWER version is the clients' consent-gate job — this
// check never demands the latest version, so paying users are not bricked
// mid-purchase when a policy is updated.
export async function hasConsentRecord(
  client: { from: (table: string) => any },
  userId: string,
): Promise<boolean> {
  const { data } = await client
    .from("consent_log")
    .select("id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle()
  return !!data
}
