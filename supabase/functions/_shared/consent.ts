// Current policy version users are asked to agree to.
// Bump this string when the Privacy Policy / Terms of Service content
// changes so existing consent rows keep their original version (immutable
// history) while new signups record the new version.
export const CONSENT_VERSION = "2026-08-07"

export function isValidConsentSource(source: unknown): source is "mobile" | "web" {
  return source === "mobile" || source === "web"
}
