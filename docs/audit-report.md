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

## Section 4 — App bundle + offline launch — ✅ PASS (verified on Android 15 emulator, arm64)

**Finding:** The app builds as a real release AAB, and a cold launch with **zero network connectivity** renders the login UI with **no crash and no blank screen**. Uncaught async errors are captured by a guarded zone and never kill the process.

### Release build (TEST dart-defines, verified 2026-08-08)

```
flutter build appbundle --release \
  --dart-define=SUPABASE_URL=https://ofvfasdgdwkehdcjugnf.supabase.co \
  --dart-define=SUPABASE_ANON_KEY=… \
  --dart-define=CLOUDINARY_CLOUD_NAME=djz0pypu1 \
  --dart-define=CLOUDINARY_UPLOAD_PRESET=cluvo_preset
```

- `app-release.aab` — **60.3 MB** ✓ (bundleRelease OK)
- `app-release.apk` — **60.9 MB** ✓ (assembleRelease OK, installed for device tests)
- ⚠️ Config guard is live: building without the required `--dart-define`s refuses to start and shows the Connection-Error screen with a Retry button (verified — the friendly error screen rendered instead of a silent misconfig or crash)

### Offline cold-start test (network fully down)

Setup: emulator `sdk_gphone16k_arm64` (Android 15, API 35) with airplane mode + `svc wifi/data disable`; connectivity verified dead (`ping` to 8.8.8.8 and `example.com` both exit non-zero, no replies).

| Check | Result |
|---|---|
| Process after launch | **alive** (`pidof com.cluvo.mobile` → PID) |
| `FATAL EXCEPTION` in logcat | **0** |
| AndroidRuntime crash lines | **0** |
| Rendered screen (OCR of screenshot) | **"Welcome back / Sign in to your account / Email / Password / Sign in / G Sign in with Google / Don't have an account? Sign up"** — full login UI, no blank screen |
| Evidence artifacts | logcat dump + screenshots (`/tmp/offline_launch.png`, `/tmp/offline_final.png`) |

### Global error handling (re-verified + hardened)

`lib/main.dart` before: `FlutterError.onError` + `PlatformDispatcher.onError` present, but **no `runZonedGuarded`** (uncaught async errors outside the framework were unguarded). Fixed in commit `0cf7faa`:

```dart
await runZonedGuarded(_bootstrap, (error, stack) {
  FlutterError.reportError(FlutterErrorDetails(exception: error, stack: stack, library: 'zone'));
});
```

### Forced-error test (real, scratch commit `fafdd8e` — reverted)

A scratch build threw `StateError('FORCED-ERROR-TEST')` from a `Timer` 3s after launch (uncaught, inside the guarded zone):

| Check | Result |
|---|---|
| Error surfaced in logcat | ✅ `I flutter : Bad state: FORCED-ERROR-TEST` (via `FlutterError.reportError`) |
| Process after the throw | **alive** (same PID) |
| `FATAL EXCEPTION` | **0** |
| UI after the throw | still rendering the login screen (OCR-verified) |
| Scratch commit | deleted — `git log` back on `0cf7faa`; working tree clean |

**Residual:** Play Console pre-launch report still to run at submission time (needs the release AAB uploaded); iOS side not covered here (Xcode incomplete on this machine).

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

## Section 8 — Deep links — ✅ PASS (custom scheme verified; dead https filter removed)

**Question (as asked):** is `cluvo://` (custom scheme) or a verified `https://` App Link the actual implementation, and does the custom-scheme approach carry a real hijacking risk worth fixing pre-submission?

**What is actually implemented (traced):**
- **Functional deep links = custom scheme `cluvo://` only.** Android manifest: single `<intent-filter>` on `MainActivity` with `scheme="cluvo"` + `DEFAULT`/`BROWSABLE` (AndroidManifest.xml:30-35). iOS: `CFBundleURLSchemes = [cluvo]` (Info.plist:13-21). No `associated-domains`/AASA file exists for iOS.
- **Credential-bearing link (password recovery)** = `cluvo://login`: `redirectTo: 'cluvo://login'` in `forgot_password_screen.dart:54`, `login_screen.dart:148`, `signup_screen.dart:214` (auth_provider.dart:265). Supabase Flutter intercepts the URI internally, PKCE-exchanges the code, fires `passwordRecovery`, router redirects to `/reset-password` (app.dart:255-261).
- **Share links** = `cluvo:///community|event/<id>` (`config.dart:48`, format asserted in `test/widget_test.dart:31`), consumed by `deep_link_service.dart` → router.
- **Removed:** the inert `https://app.cluvo.com` intent-filter (`android:autoVerify`) was deleted 2026-08-08 — `app.cluvo.com` has no DNS records and `cluvo.com` (registered 2010 via Cloudflare, expiry 2028) times out on all requests; the filter could never verify or route.

**Risk assessment (documented, accepted):**
| Vector | Exposure |
|---|---|
| Link-code theft (recovery) | **Blocked by PKCE** — an intercepted `code` is unusable without the verifier held by the legit app |
| Android chooser phishing | Real but bounded: a hostile app registering `cluvo` triggers a chooser (Android 6+); credible only with a malicious app already on-device + user error |
| iOS pre-install hijack | First-installed app wins the scheme; at pre-launch scale with zero distribution this is theoretical |
| Likelihood at current scale | Negligible — no real users, brand-specific scheme, `app.cluvo.com`/`cluvo.com` not third-party registrable |

**Verification (release-signed APK, emulator-5554, Android 15):**
- `cmd package resolve-activity -a VIEW -d cluvo://login` → **`com.cluvo.mobile/.MainActivity`** (sole resolver, no chooser)
- `cmd package resolve-activity -d cluvo:///event/abc123` → **`com.cluvo.mobile/.MainActivity`**
- `cmd package resolve-activity -d https://app.cluvo.com/x` → **Chrome** — Cluvo no longer declares anything for that host (dead filter provably gone; only `Scheme: "cluvo"` remains on MainActivity per `dumpsys` + `aapt dump xmltree`)
- Cold-start launch via `cluvo://login` and `cluvo:///event/abc123`: both **Status: ok**, process alive, **0 FATAL EXCEPTION**, screenshots OCR to the login screen ("Welcome back / Sign in to your account / Email / Password")
- Note: freshly-installed (never-launched) apps don't resolve implicit intents until first launch — stock Android stopped-package behavior, not an app defect

**Decision:** ✅ acceptable at current scale — no fix required pre-submission. Verified App Links migrated later once `cluvo.com` has a live origin (see backlog).

---

## Section 9 — Target SDK / Build Config — ✅ PASS (release-signed AAB verified)

**Build config (Flutter 3.44.0 stable):**
| Property | Value | Source |
|---|---|---|
| compileSdk / targetSdk | **36 (Android 16)** | `flutter.compileSdkVersion` / `flutter.targetSdkVersion` (FlutterExtension.kt) |
| minSdk | **24 (Android 7.0)** | `flutter.minSdkVersion` |
| AGP / Kotlin / Java | 9.0.1 / 2.3.20 / 17 (target + jvmTarget) | `android/settings.gradle.kts:22-23`, `app/build.gradle.kts:14-17,68-72` |
| R8 | minify + shrinkResources ON (`proguard-rules.pro`) | `app/build.gradle.kts:53-58` |
| Version | 1.0.0+1 | pubspec.yaml:19 |

**Play Console compliance:** new apps *and* updates must target **API 36** from **2026-08-31** (extension period to 2026-11-01) → **already compliant**.

**Evidence from the built artifacts (not config alone), `app-release.apk`:**
```
aapt badging: package: com.cluvo.mobile  versionCode='1'  versionName='1.0.0'  compileSdkVersion='36'
              sdkVersion:'24'  targetSdkVersion:'36'
              native-code: 'arm64-v8a' 'armeabi-v7a' 'x86_64'   (AAB 60.3 MB / APK 60.9 MB)
```

**Release signing (new, 2026-08-08):** `release.jks` generated (RSA-4096, alias `cluvo`, validity 30y through 31-Jul-2056); `key.properties` populated, `chmod 600`, both gitignored (`android/.gitignore:12,14`); backed up to Bitwarden (secure note + `.jks` attachment) at creation time.
```
keytool -list:  cluvo PrivateKeyEntry — SHA-256 D0:7F:5B:1F:B6:CB:B8:F1:80:7C:1E:4A:62:F0:52:DC:22:83:1B:9D:05:70:89:BB:2A:24:EF:52:58:B3:D8:B8
apksigner verify --print-certs (release APK):
  Signer #1 certificate DN: CN=Cluvo Mobile, OU=Mobile, O=Cluvo, C=IN
  Signer #1 certificate SHA-256: d07f5b1fb6cbb8f1807c1e4a62f052dc22831b9d057089bb2a24ef5258b3d8b8
  ← equals the keystore fingerprint → the release APK/AAB is signed with the real production keystore, not the debug key
```

**Residual:** pre-launch only items — Play App Signing enrolment at first upload, and running the Play Console pre-launch report on this AAB.

---

## Section 10 — Environment hygiene / secrets — ⏳ PENDING

Audit pending: confirm no keys in git history (`git log -p` sweep for `sbp_`, Razorpay/Cloudinary/Cashfree keys), `.env*` gitignored, `--dart-define` only at build time (CI-enforced `scripts/check-env-hygiene.sh`), Supabase mgmt token not in code. Note: old `.env` keys were already rotated once; fetch live keys from `api.supabase.com/v1/projects/{ref}/api-keys`.

---

## Summary

| Section | Status |
|---|---|
| 1. Data Safety map | ✅ PASS |
| 2. Account deletion | ✅ PASS (PROD-verified) |
| 3. Permissions | ✅ PASS |
| 4. App bundle + offline launch | ✅ PASS (release AAB built; offline cold-start no-crash verified; runZonedGuarded added `0cf7faa`) |
| 5. Sign-in | ✅ PASS |
| 6. Payments / Play Billing | ✅ PASS (physical-goods exemption) |
| 7. Privacy Policy + Terms | ⏳ in progress (pages live at cluvo-org.vercel.app; consent capture ✅ server-proven on TEST + Google path PROD row) |
| 8. Deep links | ✅ PASS (custom scheme verified + release-signed emulator proof; dead `app.cluvo.com` filter removed; risk accepted) |
| 9. Target SDK / Build Config | ✅ PASS (targetSdk 36 — Play-compliant; real release keystore generated + AAB release-signed) |
| 10. Secrets hygiene | ⏳ pending |

Hard blockers remaining: none beyond completing Section 7 submission fields and the Section 10 hygiene sweep.
