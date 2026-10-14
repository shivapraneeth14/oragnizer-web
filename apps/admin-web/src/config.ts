// Central environment configuration — admin-web.
//
// PERMANENT RULE: environment values are injected ONLY at build time via
// VITE_* env vars (local .env files, CI, Vercel). No environment defaults or
// hardcoded values are allowed in source code. Missing values make the app
// refuse to start (assertEnvConfigured) instead of silently picking an
// environment. Enforced by CI (scripts/check-env-hygiene.sh) and documented
// in docs/ENV.md.

export const env = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
} as const

// Optional (non-fatal) env values. Not validated by assertEnvConfigured so the
// app still builds when they are absent; features that use them degrade
// gracefully. VITE_PUBLIC_SITE_URL points at the public organizer site that
// hosts /privacy and /terms.
export const optionalEnv = {
  publicSiteUrl: import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined,
} as const

type EnvKey = keyof typeof env

export function assertEnvConfigured(): void {
  const missing = (Object.entries(env) as [EnvKey, string | undefined][]).filter(
    ([, value]) => value === undefined || value === "",
  )
  if (missing.length > 0) {
    throw new Error(
      `[config] Missing required environment variables: ${missing
        .map(([key]) => key)
        .join(", ")}. ` +
        "No environment defaults are allowed in source code — build with the required VITE_* values (see docs/ENV.md).",
    )
  }
}
