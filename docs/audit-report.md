# Play Store Readiness Audit — Cluvo

App: **Cluvo** (community events + ticketing) · Target: Google Play Store submission
Format: per item — **Finding | Evidence | Verdict | Fix | Re-verify**. No numeric score.
Status legend: ✅ PASS · ⏳ IN PROGRESS · ❌ FAIL/MISSING · 🔒 BLOCKED

---

## Section 1 — Data Safety (Play Console form) — ✅ PASS (form to be filled verbatim)

The app collects personal data, so the Play Console "Data safety" form must be completed.
The mapping below is the verbatim source for the form; the user-facing disclosures live at
`https://cluvo-org.vercel.app/privacy` (Section 7).

### Data map (Play Console data types)

| Play Console category | Value | Collected | Shared | Evidence / note |
|---|---|---|---|---|
| Email address | — | ✅ | ❌ | Sign-up/login via Supabase Auth (email/password or Google OAuth). Stored in `auth.users`, referenced by `profiles`. |
| Name (first/last), username | — | ✅ | ❌ | `profiles.first_name/last_name/username`; username is public within communities. |
| User IDs | — | ✅ | ❌ | Supabase auth UUID; internal keys of all user-owned rows. |
| Photos | Avatar, community/event media | ✅ | ✅ (Cloudinary) | `profiles.avatar_url`, community/event images uploaded to Cloudinary (upload preset), served via CDN URLs. Declared shared because Cloudinary stores/hosts them. |
| Payments info | Payment method details | ✅ | ✅ (Razorpay) | Cards/UPI are entered in Razorpay Checkout; Cluvo never stores card data. Razorpay processes and stores payment data → declare **collected + shared**. |
| Purchase history | Event ticket bookings, refunds | ✅ | ✅ (Razorpay) | `registrations` (with `payment` status/amount), `payments` rows, `payment_audit_log`; Razorpay API mirrors order/payment state. |
| App activity | Wishlist, registrations, notifications, check-ins, reviews | ✅ | ❌ | `wishlist_items`, `registrations`, `notifications`, `event_restricted_users` (check-in), `reviews`. |
| Phone number | — | ❌ | ❌ | Mobile app never requests phone; organizer-web has an optional phone field, kept empty in practice. Declared **not collected** on mobile. |
| Contacts, Location, Device ID, Diagnostics, Messaging, Audio/Video files | — | ❌ | ❌ | Not requested; no location/contacts/mic/camera permissions (see Section 3). |

### Key decisions
- Payments declared **"collected + shared"** even though Razorpay processes/stores them — Razorpay is a named third party in the policy.
- Photos declared shared with Cloudinary (image hosting provider).
- "Data deletion" question → handled by in-app account deletion (Section 2) + `supp.cluvo@gmail.com` for manual requests (matches policy Section 7).

### Security posture (context for the form's "encrypted in transit" question)
- All traffic HTTPS (Supabase, Cloudinary, Razorpay, Vercel apps).
- Supabase Row-Level Security (RLS) on all user tables; service-role key server-side only (Edge Functions); anon key with RLS enforced.
- Client secrets injected at build time via `--dart-define` (no defaults; CI-enforced by `scripts/check-env-hygiene.sh`).

---

## Section 2 — Account deletion — ✅ PASS (closed end-to-end on PRODUCTION)

Implemented via in-app **Delete Account** (`profile_screen.dart:211` → `supabase/functions/delete-account`), backed by security-definer RPC `delete_user_auth_cascade` (migration `202608060004`).

- ✅ Organizer guard: users who own communities/wallets are blocked with a user-facing message (withdraw wallet, transfer/close communities first).
- ✅ Verified on PRODUCTION (`vdxspyumkvwawmqwfkzr`): delete → HTTP 200; `profiles`/notifications/reviews/wishlist rows removed; registrations/events retained with user link severed (`user_id`/`created_by` → NULL, FK `ON DELETE SET NULL`); `audit_log` row written; subsequent login → `invalid_credentials`; old JWT → `user_not_found`; anon RPC → `Permission denied`.
- ✅ Data-retention disclosure shown in the in-app confirmation dialog (matches policy).

---

## Section 3 — Permissions — ✅ PASS

**Finding:** The app requests the minimum permission set; no sensitive runtime permissions.

**Evidence** — `apps/mobile/android/app/src/main/AndroidManifest.xml`:
| Permission | Type | Purpose |
|---|---|---|
| `android.permission.INTERNET` | Normal | Required for all network (Supabase, Cloudinary, Razorpay) |
| `android.permission.READ_EXTERNAL_STORAGE` (maxSdkVersion=32) | Runtime | Photo picker on Android ≤ 12 (legacy) |
| `android.permission.READ_MEDIA_IMAGES` | Runtime | Photo picker on Android 13+ (avatar/community images) |

No `ACCESS_FINE/COARSE_LOCATION`, `CAMERA`, `RECORD_AUDIO`, `READ_CONTACTS`, `SMS`, or phone permissions.

**Verdict:** ✅ PASS — one runtime permission group (Photos) with a clear user-facing purpose; Play Console permission declaration will list only Photos (Images).

**Fix:** None required. Optional future cleanup: switch to the system photo picker (`PickVisualMedia`) to drop runtime permissions entirely — deferred.

**Re-verify:** `adb shell pm list permissions -g -d` on a release build; confirm Play Console declaration matches.

---

## Section 4 — App bundle + offline launch — ⏳ PENDING

Not yet executed. To do before submission: build `flutter build appbundle --release` with `--dart-define` values, launch on a cold-start offline device (no network) and confirm no crash/blank screen, verify Play Console pre-launch report.

---

## Section 5 — Sign-in / Account methods — ✅ PASS

**Finding:** Users can sign in with email/password **and** Google OAuth; sign-up is enabled; account deletion is reachable in-app.

**Evidence (live, mgmt API — both TEST `ofvfasdgdwkehdcjugnf` and PROD `vdxspyumkvwawmqwfkzr`):**
- `external_email_enabled = true`
- `external_google_enabled = true`, `external_google_client_id` set
- `disable_signup = false`
- `external_apple_enabled = false`, `external_phone_enabled = false`
- `sessions_inactivity_timeout = 0` (no forced session expiry — noted in privacy policy)

**App UI:** `apps/mobile/lib/screens/login_screen.dart:145` — `supabase.auth.signInWithOAuth(google)` with Google logo button; email/password form via `signInWithPassword`. Delete Account at `apps/mobile/lib/screens/profile_screen.dart:211`.

**Verdict:** ✅ PASS — multiple sign-in options; Google sign-in meets brand-guideline use (official logo asset); Play requirement "easy account deletion" satisfied (Section 2).

**Fix:** None required.

---

## Section 6 — Payments (Play Billing applicability) — ✅ PASS

**Finding:** The only in-app purchases are **event tickets for physical, in-person events** — real-money transactions outside digital-goods content, therefore **exempt from Play Billing**; Razorpay is the payment processor.

**Evidence:**
- `apps/mobile/pubspec.yaml:41` — `razorpay_flutter: ^1.3.6`; `event_detail_screen.dart:305–337` opens Razorpay Checkout (`options` keyed by `AppConfig.razorpayKeyId`, `_razorpay.open(options)`).
- No Play Billing: no `in_app_purchase`/`billing` plugin in pubspec; no `com.android.billingclient` in any gradle file.
- No digital goods or subscriptions in the consumer app: no purchase flow for `plans`/`community_subscriptions` (those tables are unused by the mobile app; organizer-web is a web app, outside Play Billing scope).
- Purchases are physical event tickets: in-person events with capacity + QR check-in (`event_restricted_users`); refunds implemented server-side via Razorpay (`supabase/functions/verify-payment-webhook`, `reconcile-payments`).
- Wallet/payout features (Cashfree) are organizer-web-only (B2B), not in the consumer app.

**Verdict:** ✅ PASS — Play Billing exemption applies (physical goods); use of Razorpay is a permitted alternative processor. Play Console: answer "No" to in-app purchases of digital content; payments declared collected+shared (Section 1).

**Fix:** None required. Note: the app must still honor "real-money purchases" disclosure in the store listing.

---

## Section 7 — Privacy Policy & Terms — ⏳ IN PROGRESS

- Privacy Policy: `https://cluvo-org.vercel.app/privacy` (public page, no auth) — content mirrors Section 1 data map; operator "Cluvo"; contact `supp.cluvo@gmail.com`; India governing law; 13+ age gate; retention/deletion matches Section 2.
- Terms: `https://cluvo-org.vercel.app/terms`.
- In-app links: Profile → Privacy Policy / Terms (opens pages).
- Play Console: paste both URLs into App content / Data safety (privacy policy URL is required before submission).
- **Known issue:** live URLs return HTTP 200 but only serve the SPA shell (Vercel rewrite) — the pages render fully only after PR #3 (dev→main) merges; check the deployed bundle, not just the status code.

### Consent capture (server-side proof) — ✅ PASS (implemented, TEST-verified)

The "I agree to the Privacy Policy and Terms of Service" checkbox gates every account-creation path, and each consent is proven by a server-side row, not client trust.

**Design:**
- Consent checkbox appears **only on signup forms** (mobile signup screen, web register form); **sign-in screens ask nothing** — no checkbox on login (mobile or web), existing-user flow, dashboard login, or forgot-password flows.
- `consent_log` table (migration `supabase/migrations/202608070001_consent_log.sql`): `user_id` (FK auth.users, ON DELETE CASCADE), `consent_version` (text, server constant from `supabase/functions/_shared/consent.ts`, currently `2026-08-07`), `accepted_at` (server default `now()`), `source` (check `'mobile'|'web'`). RLS on, **zero policies, anon/authenticated REVOKED** — only edge functions (service role) read/write it.
- `register` edge fn rejects `consent_accepted !== true` (HTTP 400, "Please accept the Privacy Policy and Terms of Service to continue.") and mismatched `consent_version` (400); inserts the consent row server-side after account creation.
- Google OAuth accounts created outside `register` (gotrue creates them during sign-in) are covered once by a post-login consent gate (mobile + web) that shows **only while no consent row exists** for the account — returning users never see it. Recording goes through `record-consent` edge fn — idempotent, `user_id` from JWT, forged `accepted_at`/`consent_version` ignored, invalid `source` falls back to `mobile`.
- Policies open in-app in dialogs (`legal_dialog.dart`, `legal-dialog.tsx`) — no external redirect for consent.

**Evidence (live on TEST, all items passed):**
1. Schema live-verified: 5 columns, FK CASCADE, check constraint, index, RLS enabled, 0 policies, privileges: anon/authenticated revoked.
2. Email/password signup → `consent_log` row with `ids_match=true`; Google-path (gotrue admin-created users) → GET status `false` → POST `created:true` → GET `true`; second POST idempotent `created:false`; forged `accepted_at`/`consent_version` ignored (server values stored).
3. Fake client timestamp `1970-01-01` ignored — row stored with server `now()`.
4. `consent_version` bump (`2026-08-07` → `-v2`, deployed, old clients rejected 400, new row v2, old rows kept `2026-08-07`), then reverted — version constant is canonical and auditable.
5–6. anon `SELECT`/`INSERT`/`UPDATE` and authenticated `UPDATE` all rejected: `42501 permission denied for table consent_log` (401/403).
7. `consent_accepted:false` → 400 with **zero** auth.users and **zero** consent rows created; wrong version → 400, no rows.

UI/UX: signup buttons disabled until checked; sign-in screens have no consent prompt; in-dialog policy text is the same content as the public pages (shared modules `src/legal/privacy-content.tsx`, `terms-content.tsx`).

**Verdict:** ✅ consent flow implemented end-to-end and server-proven; remaining work = user's own emulator walkthrough + merging PR #3.

---

## Section 8 — Deep links — ⏳ PENDING (risk noted)

The app declares custom-scheme intent filters (`cluvo://`, `com.cluvo.mobile://`) plus an HTTPS App Link attempt on `app.cluvo.com` (assetlinks verification not confirmed). Custom schemes are user-installable-fallback fallback; review risk + consider adding assetlinks for the HTTPS domain before submission.

---

## Section 9 — Environment hygiene / secrets — ⏳ PENDING

Audit pending: confirm no keys in git history (`git log -p` sweep for `sbp_`, Razorpay/Cloudinary/Cashfree keys), `.env*` gitignored, `--dart-define` only at build time (CI-enforced `scripts/check-env-hygiene.sh`), Supabase mgmt token not in code. Note: old `.env` keys were already rotated once; fetch live keys from `api.supabase.com/v1/projects/{ref}/api-keys`.

---

## Summary

| Section | Status |
|---|---|
| 1. Data Safety map | ✅ PASS |
| 2. Account deletion | ✅ PASS (PROD-verified) |
| 3. Permissions | ✅ PASS |
| 4. App bundle + offline launch | ⏳ pending |
| 5. Sign-in | ✅ PASS |
| 6. Payments / Play Billing | ✅ PASS (physical-goods exemption) |
| 7. Privacy Policy + Terms | ⏳ in progress (pages live at cluvo-org.vercel.app; consent capture ✅ server-proven on TEST) |
| 8. Deep links | ⏳ pending (custom-scheme risk noted) |
| 9. Secrets hygiene | ⏳ pending |

Hard blocker remaining: none beyond completing Section 7 submission fields and Sections 4/8/9 checks.
