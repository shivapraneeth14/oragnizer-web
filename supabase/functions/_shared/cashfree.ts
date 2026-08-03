import { optionalEnv, requiredEnv } from "./env.ts"
import { createHmac } from "node:crypto"

const CASHFREE_CLIENT_ID = requiredEnv("CASHFREE_CLIENT_ID")
const CASHFREE_CLIENT_SECRET = requiredEnv("CASHFREE_CLIENT_SECRET")
const CASHFREE_PUBLIC_KEY = optionalEnv("CASHFREE_PUBLIC_KEY")
const IS_PRODUCTION = Deno.env.get("CASHFREE_ENV") === "production"
const BASE_URL = IS_PRODUCTION
  ? "https://api.cashfree.com/payout"
  : "https://sandbox.cashfree.com/payout"

let _signatureCache: { value: string; expires: number } | null = null

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

export async function cashfreePost(path: string, body: Record<string, unknown>) {
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
    method: "POST",
    headers,
    body: JSON.stringify(body),
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
