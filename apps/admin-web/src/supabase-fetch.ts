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
