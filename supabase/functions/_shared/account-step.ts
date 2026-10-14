// Email-first "what happens next?" decision logic, shared by the check-account
// edge function and its unit tests. Pure and dependency-free so it can be
// reasoned about — and tested — in isolation.

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase()
}

// Deliberately simple: one @, a dot in the domain, no whitespace, sane length.
// Matches the pattern already used by register/forgot-password.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(email: string): boolean {
  if (email.length === 0 || email.length > 254) return false
  return EMAIL_RE.test(email)
}

export type NextStep = "password" | "google" | "signup"

// User-facing copy is dictated by the server so every client renders the same
// words and never authors business copy. These messages NEVER mention whether
// the account is an organizer, an admin, deleted or banned — only how to proceed.
export const NEXT_STEP_MESSAGES: Record<NextStep, string> = {
  password: "Enter your password to continue.",
  google: "This email is registered with Google. Continue with Google to sign in.",
  signup: "Looks like you're new here. Create your Cluvo account to get started.",
}

// The single decision the email step makes. `hasPassword` must come from an
// authoritative server-side check (auth.users.encrypted_password via the
// service-role-only user_has_password RPC); identities alone misreport it.
export function decideNextStep(input: { userExists: boolean; hasPassword: boolean }): NextStep {
  if (!input.userExists) return "signup"
  return input.hasPassword ? "password" : "google"
}
