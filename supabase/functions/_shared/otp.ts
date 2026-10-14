import { safeEqual } from "./crypto.ts"
import { requiredEnv } from "./env.ts"

// Keyed hashing pepper for the short (6-digit) OTP. The OTP space is tiny, so a
// plain SHA-256 digest would be brute-forced instantly IF it ever leaked. HMAC
// with a server-side secret (never stored in the database) means a DB-only leak
// cannot recover codes. We reuse an existing high-entropy edge secret rather
// than introducing a new one — anyone holding it already has full DB access.
const OTP_HASH_KEY = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

// HMAC-SHA256 hex digest of the OTP, keyed by the server-side secret above.
export async function otpHash(code: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(OTP_HASH_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(code))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

// Cryptographically random 6-digit OTP. Modulo over a 32-bit draw gives an
// imperceptible bias while staying fully unpredictable to an attacker.
export function generateOtpCode(length = 6): string {
  const random = crypto.getRandomValues(new Uint32Array(1))[0]
  return String(random % 10 ** length).padStart(length, "0")
}

// Constant-time comparison between a submitted code and the stored hash so a
// wrong attempt leaks nothing via timing.
export async function otpMatches(input: string, expectedHash: string): Promise<boolean> {
  const candidate = await otpHash(input)
  return safeEqual(candidate, expectedHash)
}

// High-entropy single-use reset token returned to the client only after a code
// verifies successfully. Stored hashed; never transmitted in URLs or logs.
export function generateResetToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}