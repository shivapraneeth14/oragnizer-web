// Central environment helper for edge functions.
//
// PERMANENT RULE: environment values come ONLY from Supabase secret
// configuration (per-project, set via `supabase secrets set` / dashboard).
// Never fall back to hardcoded values, never read values from other
// projects' config. Missing required secrets fail fast with a clear error
// instead of failing later with an obscure one.

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value || value.trim() === "") {
    throw new Error(
      `[env] Missing required environment variable: ${name}. ` +
        "Set it via `supabase secrets set` in the correct project environment (see docs/ENV.md).",
    )
  }
  return value
}

export function optionalEnv(name: string): string | undefined {
  const value = Deno.env.get(name)
  return value && value.trim() !== "" ? value : undefined
}
