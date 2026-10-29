import { optionalEnv } from "./env.ts"

export const DEFAULT_ALLOWED_ORIGINS = [
  "https://cluvo.app",
  "https://www.cluvo.app",
  "https://org.cluvo.app",
  "https://admin.cluvo.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:8080",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
]

export function isOriginAllowed(origin: string, allowedList: string[]): boolean {
  if (allowedList.includes(origin)) return true
  return allowedList.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2)
      try {
        const parsed = new URL(origin)
        return parsed.hostname === suffix || parsed.hostname.endsWith("." + suffix)
      } catch {
        return false
      }
    }
    return false
  })
}

export function getCorsHeaders(req?: Request): Record<string, string> {
  const configured = optionalEnv("ALLOWED_ORIGINS")
  const allowedList = configured
    ? configured.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS

  const origin = req?.headers?.get("origin")
  let allowOrigin = "*"
  if (origin) {
    const allowed = isOriginAllowed(origin, allowedList)
    allowOrigin = allowed ? origin : allowedList[0]
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
  }
}
