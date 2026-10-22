import { env } from "./config"

export async function supabaseFetch(path: string, token: string | undefined, body: unknown) {
  const res = await fetch(`${env.supabaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  return res
}

export async function supabaseFetchNoAuth(path: string, body: unknown) {
  const res = await fetch(`${env.supabaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.supabaseAnonKey}`,
    },
    body: JSON.stringify(body),
  })
  return res
}

export const ORGANIZER_GATE_MESSAGE =
  "You can't sign in here with this account. It doesn't have a community yet — sign up as an organizer to create one."

export interface OrganizerSessionVerdict {
  ok: boolean
  organizer: boolean
  // True only when the gate could not be reached (network/offline). Callers
  // should offer a retry rather than treating this as a denial.
  networkError: boolean
  // True when the account is in its 30-day deletion grace period. This is not
  // a session failure — the user can restore the account from the mobile app.
  deletionGrace?: boolean
  message: string
  error: string | null
}

export async function checkOrganizerSession(
  token: string | undefined,
): Promise<OrganizerSessionVerdict> {
  try {
    const res = await supabaseFetch("/functions/v1/check-organizer", token, {})
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (data.deletion_grace === true) {
        // Account is in its deletion grace period. Not an auth failure —
        // surface it so the UI can offer a restore path instead of signing
        // the user out.
        return {
          ok: false,
          organizer: false,
          networkError: false,
          deletionGrace: true,
          message:
            typeof data.message === "string"
              ? data.message
              : "Your account is scheduled for deletion.",
          error: null,
        }
      }
      // Reached the server but the session was rejected (e.g. invalid/expired).
      return {
        ok: false,
        organizer: false,
        networkError: false,
        message:
          typeof data.message === "string" ? data.message : ORGANIZER_GATE_MESSAGE,
        error: "Your session is invalid or expired. Please sign in again.",
      }
    }
    return {
      ok: true,
      organizer: data.organizer === true,
      networkError: false,
      message:
        typeof data.message === "string" ? data.message : ORGANIZER_GATE_MESSAGE,
      error: null,
    }
  } catch {
    // Fail closed: no verdict means no access. Surface a retry opportunity
    // instead of silently granting (or permanently denying) access.
    return {
      ok: false,
      organizer: false,
      networkError: true,
      message: ORGANIZER_GATE_MESSAGE,
      error: "Connection error. Check your internet and try again.",
    }
  }
}
