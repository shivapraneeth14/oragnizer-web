# Environment Configuration — Cluvo web apps + edge functions

## PERMANENT RULE

Never introduce environment-specific defaults or hardcoded configuration into source code. All environment-specific values must be supplied through build-time environment variables or deployment secrets. Any future integration (payments, maps, analytics, storage, notifications, AI providers, etc.) must follow this architecture.

- **Organizer web / Admin web (Vite + React)**: every value is read from `import.meta.env.VITE_*`, centralized in `src/config.ts`. The app **refuses to start** (`assertEnvConfigured()` in `src/main.tsx`) when any required variable is missing. There is no fallback anywhere (see `src/lib/share.ts`, `src/pages/landing.tsx`, `src/components/payout/payout-section.tsx` for previously-fixed fallbacks).
- **Edge functions (Deno)**: every value is read per-project via `Deno.env.get`, centralized in `supabase/functions/_shared/env.ts` (`requiredEnv` / `optionalEnv`). A missing required secret makes the function **fail fast with a clear error**.
- **CI** enforces this permanently: `scripts/check-env-hygiene.sh` (env-hygiene job) fails on hardcoded supabase URLs/keys, JWTs, payment keys, third-party API key patterns, and any `||`/`??`/`||=`/`??=` default on an env read. `scripts/`, `docs/`, `.vscode/launch.json`, and the Flutter `apps/mobile/env*.json` build-define files are the only allowed places for concrete values (they are injection tooling, not source). Those tooling files may hold **client-public** values only — Supabase URL + anon/publishable key, Cloudinary cloud/preset, Razorpay key_id; **server secrets never live there** (the mobile `check-env-hygiene.sh` fails if a secret-shaped value appears in `env*.json`).

## Environments

| Surface | TEST | PROD |
|---|---|---|
| Supabase URL | `https://ofvfasdgdwkehdcjugnf.supabase.co` | `https://vdxspyumkvwawmqwfkzr.supabase.co` |
| Supabase anon key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mdmZhc2RnZHdrZWhkY2p1Z25mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1OTkxNDcsImV4cCI6MjEwMTE3NTE0N30.oaxiWOFClGzO1WqBihmLoZV69soVpfMv6gtUMnMakxY` | `sb_publishable_phag39UwA63y44O1703IkA_Ky6ebjwV` |
| Cloudinary cloud / preset | `djz0pypu1` / `cluvo_preset` | `djz0pypu1` / `cluvo_preset` |
| Razorpay | `rzp_test_*` (secrets) | `rzp_live_*` (secrets) |
| Cashfree | sandbox (secrets) | production (secrets) |
| Vercel deploy | dev preview / `cluvo-git-dev-shiva-praneeths-projects.vercel.app` | `cluvo-nu.vercel.app` |

## Admin access (admin-web) — PERMANENT per-environment rule

Admin identity is **per-project**: `profiles.is_admin` lives in each project's own database, and the admin-web login
checks it against whichever project the app is pointed at. An account that is admin in one environment is **not**
admin in the other — admin changes made in TEST never touch PROD and vice versa.

| Environment | Admin accounts (email / password) | Notes |
|---|---|---|
| TEST (`ofvfasdgdwkehdcjugnf`) | `shivapraneeth01@gmail.com` / `<set via seed-admin — never store in docs>` | also admin in PROD? No — plain user there |
| TEST (`ofvfasdgdwkehdcjugnf`) | `admin@cluvo-test.app` / `<set via seed-admin — never store in docs>` | exists only in TEST |
| PROD (`vdxspyumkvwawmqwfkzr`) | `shivakandala43@gmail.com` / `<set via PROD seed-admin — never store in docs>` | admin only in PROD |

- Logging in locally or via a preview build (pointed at TEST) requires a TEST admin account.
- Logging in on the production deployment requires a PROD admin account.
- To add/change admins in one environment, use the `seed-admin` edge function against that project only
  (`supabase secrets set ADMIN_EMAIL=... ADMIN_PASSWORD=... --project-ref <ref>` then invoke the function).
  Note: `seed-admin` hardcodes `username: "admin"`, so it cannot create a second account while
  `admin@cluvo-test.app` exists — create additional admins via the auth admin API with a unique username,
  then set `profiles.is_admin = true`.

## Auth redirect allow-list (Supabase Auth) — PERMANENT rule

When a login redirect target (`redirectTo` from OAuth or a password-reset link) is **not** in the project's
`uri_allow_list`, Supabase Auth falls back to `site_url` — which in PROD is `https://cluvo-nu.vercel.app`
(the Flutter app). Symptom of a missing entry: admin login via Google bounces to the Flutter web app
instead of the admin dashboard (same for `/reset-password` links).

- Every surface added to an environment must have its URLs in that environment's auth `uri_allow_list`
  (Supabase Dashboard → Auth → URL Configuration, or Management API `config/auth`).
- **PROD** (`vdxspyumkvwawmqwfkzr`): must include `https://cluvo-admin-five.vercel.app/**` and
  `https://cluvo-admin-*.vercel.app/**` (preview deployments), plus the existing mobile
  (`cluvo://login`, `com.cluvo.mobile://login`, `cluvo://signup`), organizer-web
  (`cluvo-org.vercel.app/**`), and Flutter (`cluvo-nu.vercel.app/**`) entries — do not remove them.
- **TEST** (`ofvfasdgdwkehdcjugnf`): allow list includes `localhost:5173`, `localhost:3000`, plus the mobile
  deep-link schemes `cluvo://login`, `cluvo://signup`, `com.cluvo.mobile://login`. Google sign-in **is** enabled
  on TEST (existing accounts have linked Google identities) — recovery links for those accounts redirect to
  `cluvo://login`, so the schemes must stay in the list. If a hosted TEST surface ever needs OAuth, add its URL
  to the allow list first.
- `site_url` staying at `https://cluvo-nu.vercel.app` is intentional (Flutter is the main consumer app);
  the admin portal is covered by its allow-list entries.

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

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `CASHFREE_PUBLIC_KEY` (optional), `CASHFREE_WEBHOOK_SECRET`, `CASHFREE_ENV` (`sandbox`|`production` — selects Cashfree base URL), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (optional), `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SENDER_EMAIL` (Gmail SMTP for the password-reset OTP + confirmation emails — see below). `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD_*` are CI/deploy-only secrets, never used at runtime.

### Password reset OTP edge functions (`forgot-password`, `verify-otp`, `change-password`)

Password resets on the mobile app and organizer-web use a custom email-OTP flow served by three edge
functions inside a dialog/modal — no page navigation, and no GoTrue recovery link is used on those surfaces
(admin-web still uses GoTrue's `/reset-password` page with a link plus the branded template).

- `forgot-password`: input `{ email, requireOrganizer }`. Looks up the user by email. Unknown /
  Google-only / (when `requireOrganizer`) non-organizer emails all return the **same neutral copy**:
  `{ sent: false, message: "If your email uses password login, a verification code has been sent. If it uses Google, please sign in with Google instead." }`
  — no account enumeration to the client. Known password users get a 6-digit code upserted into
  `password_reset_otps` (only the latest code is valid), a 10-minute expiry, and a 30s server-side resend
  cooldown → `{ sent: true, expiresIn: 600 }`.
- `verify-otp`: input `{ email, code }`. Constant-time compare against the stored hash; 5 wrong attempts or
  expiry destroy the code; success mints a single-use reset token (stored hashed, 10-minute expiry) →
  `{ token, expiresIn: 600 }`.
- `change-password`: input `{ token, password }`. Enforces the password policy server-side (8+ chars, ≥1
  capital), applies it via `supabase.auth.admin.updateUserById` on the existing account — **no session is
  ever created** — consumes the token, sends a confirmation email, → `{ ok: true }`.

Per-IP rate limits live in `_shared/rate-limit.ts`: `forgot-password` 10/300, `verify-otp` 10/300,
`change-password` 10/300. Uses `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` plus the `SMTP_*` secrets.

### Deploying migration + edge functions (manual, per project)

```bash
supabase db push --project-ref <test|prod ref>
supabase functions deploy forgot-password verify-otp change-password --project-ref <test|prod ref>
supabase secrets set --env-file .env --project-ref <test|prod ref>
```

## Password reset OTP email — Gmail SMTP (free)

OTP and confirmation emails are sent by the edge functions themselves via `nodemailer`
(`supabase/functions/_shared/send-email.ts`) using per-project `SMTP_*` secrets — **not** the GoTrue mailer.
The branded recovery-link template in `supabase/templates/recovery.html` is only used by admin-web's GoTrue
`/reset-password` flow.

### Hosted projects (TEST + PROD) — per-project edge secrets

Set these secrets separately in **each** project (`supabase secrets set --env-file .env --project-ref <ref>`):

| Variable | Purpose |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | Gmail address used to authenticate (e.g. `supp.cluvo@gmail.com`) |
| `SMTP_PASS` | 16-character Google **App Password** (2-Step Verification required) |
| `SMTP_SENDER_EMAIL` | From address (same Gmail address) |

The App Password is a **secret**: it lives only in the gitignored `supabase/.env`.

### Local development

`supabase functions serve` reads SMTP values from the process environment via `env(...)`; put them in the
gitignored `supabase/.env`. Placeholders are in `supabase/.env.example`.

### Caveats

- App Passwords require 2-Step Verification; some Google Workspace admins disable them.
- Free Gmail sends ~500 recipients/day and may throttle — move to a transactional
  provider (e.g. Brevo free) if volume grows; that is a secrets/config-only change.
- The From address is the Gmail account; a custom alias needs Gmail "Send mail as".

## Single source of truth

**Local development (web):** `./scripts/switch-supabase.sh test|prod` writes `apps/organizer-web/.env` and `apps/admin-web/.env` with matching values (including an env-appropriate `VITE_APP_URL`). `.env` files are gitignored.

**Local development (Flutter app, `apps/mobile` — separate repo):** two sanctioned launchers, both injected at build time via `--dart-define`:

1. **VS Code Run button (recommended):** install the **Dart** extension once (`dart-code.dart-code`), then fully **restart VS Code** (extensions load only at startup). The committed `.vscode/launch.json` at the repo root ships the **Cluvo (TEST)** configuration whose `toolArgs` pass the four TEST defines — pick the device (bottom-right selector, e.g. Pixel_9) and press **F5**. This workspace-root config is committed via the `!.vscode/launch.json` exception in `.gitignore` (values live in tooling, not source — see permanent rule).
2. **Terminal:** `apps/mobile/scripts/run.sh test <device-id>` (or `prod`). Never type bare `flutter run` — with no defines the app refuses to start by design (fail-fast screen).
3. **Android Studio (local, per machine):** the gitignored run configuration `.idea/runConfigurations/main_dart.xml` passes the same `--dart-define-from-file=env.test.json` as VS Code/CI. If you get the fail-fast screen ("Supabase / Cloudinary are not configured"), the app was started without defines. Fix: Run ▸ Edit Configurations ▸ select (or add) the **Flutter** config named **main.dart** with **Dart entrypoint** `$PROJECT_DIR$/lib/main.dart` and **Additional run args** `--dart-define-from-file=env.test.json`; make sure that config is selected next to the ▶ button, then restart Android Studio and run.

**CI (this repo, `.github/workflows/ci.yml`):**
- `env-hygiene` job: `./scripts/check-env-hygiene.sh`.
- `build-web` job: selects `SUPABASE_URL_PROD`/`SUPABASE_ANON_KEY_PROD` secrets on `main`, otherwise `*_TEST`; cloudinary/APP values are static because they are identical in both environments.
- `supabase-migrations` (lint only, non-deploying): links to PROD on `main`, TEST elsewhere.
- Deployment: `deploy-prod.yml` (main → PROD project) and `deploy-test.yml` (dev → TEST project) — do not modify these.

**GitHub secrets (this repo, via `gh secret set`):** `SUPABASE_URL_PROD`, `SUPABASE_ANON_KEY_PROD`, `SUPABASE_URL_TEST`, `SUPABASE_ANON_KEY_TEST`, plus existing `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD_PROD`, `SUPABASE_DB_PASSWORD_TEST`.

**Vercel:** Production scope keeps PROD `SUPABASE_URL` + `SUPABASE_ANON_KEY` (set in the dashboard, not committed). Preview scope is set to the TEST project's values, so every preview link exercises TEST. Cloudinary variables are static (same in both environments).

**Edge functions:** set secrets separately per project: `supabase secrets set --env-file .env --project-ref <test|prod ref>` — never assume a value set in one project exists in the other.

## Why this cannot break under normal git workflows

Because **no secret and no environment value lives in application source code** (client-public values are confined to build tooling: `scripts/`, `docs/`, `.vscode/launch.json`, and the Flutter `env*.json` define files), no merge, rebase, cherry-pick, hotfix, rollback, or release operation can change which environment a build uses. Environment is decided only by the deployment channel:

| Operation | Effect on environment |
|---|---|
| `git merge` / `git rebase` / `git cherry-pick` | None — no values in tracked files |
| Rollback / `git reset --hard` / checkout of any commit | None — same values injected per channel |
| Push to `main` | CI + Vercel production → PROD values |
| Push to `dev` / PR | CI + Vercel preview → TEST values |
| Local build without env vars | Fails fast at startup (web) / clear missing-secret error (functions) |
