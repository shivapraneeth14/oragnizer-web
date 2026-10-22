// Redacting logger for edge functions.
//
// Console.log/error in edge functions writes to Supabase Logs Explorer,
// which is external to the app database and outside the deletion path.
// Printing raw error objects from GoTrue, SMTP (nodemailer), or PostgREST
// can leak user emails, bank details, or auth tokens into those logs.
//
// This module provides log functions that NEVER print the raw error object.
// They extract only a short, safe message string and truncate it.

const MAX_MESSAGE_LEN = 300

// Redact patterns that commonly appear in provider/PostgREST error messages.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const BEARER_RE = /Bearer\s+[A-Za-z0-9._-]+/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/gi

export function redact(text: string): string {
  return text
    .replace(EMAIL_RE, "[email]")
    .replace(BEARER_RE, "Bearer [token]")
    .replace(JWT_RE, "[jwt]")
    .replace(LONG_HEX_RE, "[hex]")
}

export function safeMessage(err: unknown): string {
  if (err instanceof Error) return redact(err.message).slice(0, MAX_MESSAGE_LEN)
  if (typeof err === "string") return redact(err).slice(0, MAX_MESSAGE_LEN)
  if (err && typeof err === "object") {
    // PostgREST errors: { message, details, hint, code } — only the short
    // message is printed, never details (which echo row values).
    const e = err as Record<string, unknown>
    const msg = typeof e.message === "string" ? e.message : String(err)
    return redact(msg).slice(0, MAX_MESSAGE_LEN)
  }
  return redact(String(err)).slice(0, MAX_MESSAGE_LEN)
}

export function logError(context: string, err: unknown): void {
  console.error(`[${context}] ${safeMessage(err)}`)
}

export function logInfo(context: string, message: string): void {
  console.log(`[${context}] ${message.slice(0, MAX_MESSAGE_LEN)}`)
}
