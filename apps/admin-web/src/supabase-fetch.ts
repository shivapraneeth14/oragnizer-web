import { env } from "./config"

export async function supabaseFetch(path: string, token: string | undefined, body: unknown) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (token) headers["Authorization"] = `Bearer ${token}`
  if (env.supabaseAnonKey) headers["apikey"] = env.supabaseAnonKey

  const res = await fetch(`${env.supabaseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  return res
}
