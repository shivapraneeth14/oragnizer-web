## Backlog

### MUST DO BEFORE LAUNCH
- **✅ DONE**: Withdrawal minimum restored to ₹100 (`MIN_WITHDRAWAL = 100` in
  `supabase/functions/withdraw-wallet/index.ts`, guard uses `amount < MIN_WITHDRAWAL * 100`).
  Frontend hint text updated to "Minimum withdrawal: ₹100."
- **Migrate auth email sending off Supabase's default service**: Still on Supabase's
  built-in default email service (sender `no-reply@supabase.co`, `rate_limit_email_sent=2`
  per address-hour, 60/hr per project). Migrate to Resend (requires a verified domain —
  no domain exists yet) before real user growth exceeds the rate limit, or before a
  Play Store launch push. Until then, keep test emails paced (2+/hr per address, same IP
  can exhaust the window faster).
- **Confirm age minimum & DPDP compliance with legal counsel**: Age minimum and full
  legal compliance for India's DPDP framework should be confirmed with a legal professional
  before real public launch — 13+ is a reasonable placeholder matching Play Store's general
  baseline, not a confirmed legal determination. (Privacy Policy at
  `apps/organizer-web/src/pages/privacy-policy.tsx` states 13+ and India governing law.)

### Pending (not blocking current tier)
- **Rotate legacy Razorpay TEST key `rzp_test_THqWNZqOZGQZOu`** (audit §10): this sandbox-only key was committed in old `lib/config.dart` defaults (mobile history; see `a94c600`), is **gone from the current tree**, and cannot process real payments — but history is immutable, so revoke/regenerate it at the Razorpay dashboard to kill the committed value. Also: the live-key re-fetch from the Supabase mgmt API (`api.supabase.com/v1/projects/{ref}/api-keys`) still needs a Supabase access token — none exists on this machine; either create one (dashboard → Account → Access Tokens) and hand it to this session, or accept the "rotated earlier (2026-08-04), current keys live only in gitignored `.env`" status as final.
- **Migrate Cashfree Payouts V1 → V2**: Cashfree warns V1 transfers APIs will be
  retired; plan migration to Transfers V2 (`_shared/cashfree.ts` + `withdraw-wallet`).
- **Migrate deep links to verified Android App Links / iOS Universal Links**: Password-recovery and share links currently use the custom scheme `cluvo://` (PKCE-protected recovery flows; the residual chooser-phishing/pre-install-hijack risk was assessed and accepted at current pre-launch scale — see audit-report §8). Migration needs a live HTTPS origin: `cluvo.com` is registered (Cloudflare, expires 2028) but serves nothing and `app.cluvo.com` has no DNS records. Then: serve `/.well-known/assetlinks.json` (SHA-256 = `D0:7F:5B:1F:B6:CB:B8:F1:80:7C:1E:4A:62:F0:52:DC:22:83:1B:9D:05:70:89:BB:2A:24:EF:52:58:B3:D8:B8`) + `apple-app-site-association`, switch the recovery `redirectTo` in `apps/mobile/lib/screens/{forgot-password,login,signup}_screen.dart` + `auth_provider.dart:265` from `cluvo://login` to the https link, update Supabase Auth redirect URLs, and re-add the https intent-filter to `AndroidManifest.xml`.
- **✅ DONE**: Retry cap added to reconcile-payments — payments pending >2h are
  marked failed + logged as `payment_reconcile_gave_up` for manual review. Only payments
  10 min–2h old are checked against Razorpay each cycle.
