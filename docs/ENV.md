# Environment Configuration — Cluvo web apps + edge functions

## PERMANENT RULE

Never introduce environment-specific defaults or hardcoded configuration into source code. All environment-specific values must be supplied through build-time environment variables or deployment secrets. Any future integration (payments, maps, analytics, storage, notifications, AI providers, etc.) must follow this architecture.

- **Organizer web / Admin web (Vite + React)**: every value is read from `import.meta.env.VITE_*`, centralized in `src/config.ts`. The app **refuses to start** (`assertEnvConfigured()` in `src/main.tsx`) when any required variable is missing. There is no fallback anywhere (see `src/lib/share.ts`, `src/pages/landing.tsx`, `src/components/payout/payout-section.tsx` for previously-fixed fallbacks).
- **Edge functions (Deno)**: every value is read per-project via `Deno.env.get`, centralized in `supabase/functions/_shared/env.ts` (`requiredEnv` / `optionalEnv`). A missing required secret makes the function **fail fast with a clear error**.
- **CI** enforces this permanently: `scripts/check-env-hygiene.sh` (env-hygiene job) fails on hardcoded supabase URLs/keys, JWTs, payment keys, third-party API key patterns, and any `||`/`??`/`||=`/`??=` default on an env read. `scripts/` and `docs/` are the only allowed places for concrete values (they are injection tooling, not source).

## Environments

| Surface | TEST | PROD |
|---|---|---|
| Supabase URL | `https://ofvfasdgdwkehdcjugnf.supabase.co` | `https://vdxspyumkvwawmqwfkzr.supabase.co` |
| Supabase anon key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mdmZhc2RnZHdrZWhkY2p1Z25mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1OTkxNDcsImV4cCI6MjEwMTE3NTE0N30.oaxiWOFClGzO1WqBihmLoZV69soVpfMv6gtUMnMakxY` | `sb_publishable_phag39UwA63y44O1703IkA_Ky6ebjwV` |
| Cloudinary cloud / preset | `djz0pypu1` / `cluvo_preset` | `djz0pypu1` / `cluvo_preset` |
| Razorpay | `rzp_test_*` (secrets) | `rzp_live_*` (secrets) |
| Cashfree | sandbox (secrets) | production (secrets) |
| Vercel deploy | dev preview / `cluvo-git-dev-shiva-praneeths-projects.vercel.app` | `cluvo-nu.vercel.app` |

## Variable inventory

### apps/organizer-web — required (refuses to start without ALL of these)

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Supabase REST/graphql endpoint |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/publishable key |
| `VITE_CLOUDINARY_CLOUD_NAME` | Cloudinary upload |
| `VITE_CLOUDINARY_UPLOAD_PRESET` | Cloudinary unsigned upload preset |
| `VITE_APP_DEEPLINK_BASE` | Mobile deep link base for share links (`cluvo://`) |
| `VITE_APP_URL` | Web share base URL |

### apps/admin-web — required (refuses to start without ALL of these)

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Supabase REST endpoint |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/publishable key |

### Edge functions — per-project Supabase secrets (missing ⇒ fail fast)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `CASHFREE_PUBLIC_KEY` (optional), `CASHFREE_WEBHOOK_SECRET`, `CASHFREE_ENV` (`sandbox`|`production` — selects Cashfree base URL), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (optional). `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD_*` are CI/deploy-only secrets, never used at runtime.

## Single source of truth

**Local development (web):** `./scripts/switch-supabase.sh test|prod` writes `apps/organizer-web/.env` and `apps/admin-web/.env` with matching values (including an env-appropriate `VITE_APP_URL`). `.env` files are gitignored.

**CI (this repo, `.github/workflows/ci.yml`):**
- `env-hygiene` job: `./scripts/check-env-hygiene.sh`.
- `build-web` job: selects `SUPABASE_URL_PROD`/`SUPABASE_ANON_KEY_PROD` secrets on `main`, otherwise `*_TEST`; cloudinary/APP values are static because they are identical in both environments.
- `supabase-migrations` (lint only, non-deploying): links to PROD on `main`, TEST elsewhere.
- Deployment: `deploy-prod.yml` (main → PROD project) and `deploy-test.yml` (dev → TEST project) — do not modify these.

**GitHub secrets (this repo, via `gh secret set`):** `SUPABASE_URL_PROD`, `SUPABASE_ANON_KEY_PROD`, `SUPABASE_URL_TEST`, `SUPABASE_ANON_KEY_TEST`, plus existing `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD_PROD`, `SUPABASE_DB_PASSWORD_TEST`.

**Vercel:** Production scope keeps PROD `SUPABASE_URL` + `SUPABASE_ANON_KEY` (set in the dashboard, not committed). Preview scope is set to the TEST project's values, so every preview link exercises TEST. Cloudinary variables are static (same in both environments).

**Edge functions:** set secrets separately per project: `supabase secrets set --env-file .env --project-ref <test|prod ref>` — never assume a value set in one project exists in the other.

## Why this cannot break under normal git workflows

Because **no environment value lives in tracked source code**, no merge, rebase, cherry-pick, hotfix, rollback, or release operation can change which environment a build uses. Environment is decided only by the deployment channel:

| Operation | Effect on environment |
|---|---|
| `git merge` / `git rebase` / `git cherry-pick` | None — no values in tracked files |
| Rollback / `git reset --hard` / checkout of any commit | None — same values injected per channel |
| Push to `main` | CI + Vercel production → PROD values |
| Push to `dev` / PR | CI + Vercel preview → TEST values |
| Local build without env vars | Fails fast at startup (web) / clear missing-secret error (functions) |
