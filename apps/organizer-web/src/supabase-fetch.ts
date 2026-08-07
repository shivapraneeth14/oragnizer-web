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

export async function checkOrganizerSession(token: string | undefined) {
  try {
    const res = await supabaseFetch("/functions/v1/check-organizer", token, {})
    const data = await res.json().catch(() => ({}))
    return {
      ok: res.ok,
      organizer: data.organizer === true,
      message:
        typeof data.message === "string" ? data.message : ORGANIZER_GATE_MESSAGE,
    }
  } catch {
    // Fail open on network errors — never sign someone out because of a blip
    return { ok: false, organizer: true, message: ORGANIZER_GATE_MESSAGE }
  }
}
