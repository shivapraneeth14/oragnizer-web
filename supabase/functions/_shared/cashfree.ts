import { createHmac } from "node:crypto"

const CASHFREE_CLIENT_ID = Deno.env.get("CASHFREE_CLIENT_ID")!
const CASHFREE_CLIENT_SECRET = Deno.env.get("CASHFREE_CLIENT_SECRET")!
const IS_PRODUCTION = Deno.env.get("CASHFREE_ENV") === "production"
const BASE_URL = IS_PRODUCTION
  ? "https://api.cashfree.com/payout"
  : "https://payout-gamma.cashfree.com/payout/v1"

let _token: string | null = null
let _tokenExpiry = 0

async function getToken(): Promise<string> {
  if (_token && Date.now() < _tokenExpiry) return _token

  const res = await fetch(`${BASE_URL}/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": CASHFREE_CLIENT_ID,
      "x-client-secret": CASHFREE_CLIENT_SECRET,
    },
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Cashfree auth failed: ${res.status} ${err}`)
  }

  const data = await res.json()
  _token = data.sub_token
  _tokenExpiry = Date.now() + 30 * 60 * 1000
  return _token!
}

export async function cashfreePost(path: string, body: Record<string, unknown>) {
  const token = await getToken()
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.message || data.error || `Cashfree API error (${res.status})`)
  }
  return data
}

export function verifyCashfreeWebhook(rawBody: string, signature: string, secret: string): boolean {
  const hmac = createHmac("sha256", secret)
  hmac.update(rawBody)
  const expected = hmac.digest("base64")
  return expected === signature
}
