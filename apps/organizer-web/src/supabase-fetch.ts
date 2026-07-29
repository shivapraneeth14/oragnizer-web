const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export async function supabaseFetch(path: string, token: string | undefined, body: unknown) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
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
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ANON_KEY}`,
    },
    body: JSON.stringify(body),
  })
  return res
}
