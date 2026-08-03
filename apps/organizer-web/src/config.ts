// Central environment configuration — organizer-web.
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
  cloudinaryCloudName: import.meta.env.VITE_CLOUDINARY_CLOUD_NAME,
  cloudinaryUploadPreset: import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET,
  appDeepLinkBase: import.meta.env.VITE_APP_DEEPLINK_BASE,
  appUrl: import.meta.env.VITE_APP_URL,
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
