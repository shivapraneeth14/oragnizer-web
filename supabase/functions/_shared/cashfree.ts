import { optionalEnv, requiredEnv } from "./env.ts"
import { createHmac } from "node:crypto"

const CASHFREE_CLIENT_ID = requiredEnv("CASHFREE_CLIENT_ID")
const CASHFREE_CLIENT_SECRET = requiredEnv("CASHFREE_CLIENT_SECRET")
const CASHFREE_PUBLIC_KEY = optionalEnv("CASHFREE_PUBLIC_KEY")
const IS_PRODUCTION = Deno.env.get("CASHFREE_ENV") === "production"
const BASE_URL = IS_PRODUCTION
  ? "https://api.cashfree.com/payout"
  : "https://sandbox.cashfree.com/payout"

// Read APIs (authorize + getTransferStatus) live on the official API hosts;
// the sandbox host above proxies writes but rejects token-based auth.
const READ_BASE = IS_PRODUCTION
  ? "https://payout-api.cashfree.com"
  : "https://payout-gamma.cashfree.com"

let _signatureCache: { value: string; expires: number } | null = null
let _tokenCache: { value: string; expires: number } | null = null

async function generateSignature(): Promise<string> {
  if (_signatureCache && Date.now() < _signatureCache.expires) return _signatureCache.value

  const pem = CASHFREE_PUBLIC_KEY!
  const pemBody = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s/g, "")
  const raw = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0))

  const publicKey = await crypto.subtle.importKey(
    "spki", raw,
    { name: "RSA-OAEP", hash: "SHA-1" },
    false, ["encrypt"],
  )

  const ts = Math.floor(Date.now() / 1000)
  const payload = `${CASHFREE_CLIENT_ID}.${ts}`
  const encrypted = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" }, publicKey,
    new TextEncoder().encode(payload),
  )

  const value = btoa(String.fromCharCode(...new Uint8Array(encrypted)))
  _signatureCache = { value, expires: ts + 50 }
  return value
}

// Payouts v1.2 read APIs need an Authorization bearer token obtained from
// /authorize using the RSA signature (X-Cf-Signature) + client credentials.
async function authorizeToken(): Promise<string> {
  if (_tokenCache && Date.now() < _tokenCache.expires) return _tokenCache.value

  const res = await fetch(`${READ_BASE}/payout/v1/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": CASHFREE_CLIENT_ID,
      "x-client-secret": CASHFREE_CLIENT_SECRET,
      "x-cf-signature": await generateSignature(),
    },
  })
  const data = await res.json()
  if (!res.ok || data?.status === "ERROR" || !(data?.data?.token ?? data?.token)) {
    throw new Error(data.message || data.subCode || data.code || `Cashfree authorize failed (${res.status})`)
  }

  const value = data?.data?.token ?? data?.token
  _tokenCache = { value, expires: Date.now() + 50 * 1000 }
  return value
}

export async function cashfreePost(path: string, body: Record<string, unknown>) {
  const res = await cashfreeFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  })
  return res
}

export async function cashfreeGet(path: string) {
  // v1.2 read APIs (e.g. getTransferStatus) authenticate with a signed
  // Bearer token obtained from /authorize.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-client-id": CASHFREE_CLIENT_ID,
    "x-api-version": "2024-01-01",
    Authorization: `Bearer ${await authorizeToken()}`,
  }

  const res = await fetch(`${READ_BASE}/payout/v1.1${path}`, { method: "GET", headers })
  const data = await res.json()
  if (!res.ok || data?.status === "ERROR") {
    throw new Error(data.message || data.subCode || data.code || `Cashfree API error (${res.status})`)
  }
  return data
}

async function cashfreeFetch(path: string, init: { method: string; body?: string }) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-client-id": CASHFREE_CLIENT_ID,
    "x-client-secret": CASHFREE_CLIENT_SECRET,
    "x-api-version": "2024-01-01",
  }
  if (CASHFREE_PUBLIC_KEY) {
    headers["x-cf-signature"] = await generateSignature()
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method,
    headers,
    body: init.body,
  })
  const data = await res.json()
  if (!res.ok || data?.status === "ERROR") {
    throw new Error(data.message || data.subCode || data.code || `Cashfree API error (${res.status})`)
  }
  return data
}

export function verifyCashfreeWebhook(rawBody: string, signature: string, secret: string): boolean {
  const hmac = createHmac("sha256", secret)
  hmac.update(rawBody)
  const expected = hmac.digest("base64")
  return expected === signature
}
