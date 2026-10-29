# Audit Scope

## Source verification
- Repository root successfully verified: `/Users/shivapraneeth/Documents/community`.
- Git branch: `dev`; HEAD at `59eea61ddbb622d1fd11a42719c66c3da4e6ca30` (2026-10-30), worktree has pre-existing untracked `.agents/`, `.opencode/`, `audit/`, `deno.lock`, and `skills-lock.json`.
- Origin: `https://github.com/shivapraneeth14/oragnizer-web.git`.
- Audit artifacts are explicitly requested under `audit/payment-security/`; application source has not been modified.

## Accessible applications
- Flutter customer app: `apps/mobile/` (source and tests readable).
- Organizer React app: `apps/organizer-web/`.
- Admin React app: `apps/admin-web/`.
- Supabase Edge Functions: `supabase/functions/`.
- PostgreSQL migrations: `supabase/migrations/`.
- Supabase tests: `supabase/tests/`.
- CI/deploy workflows: `.github/workflows/`.
- No separate Flutter repository was found in the parent directory search; `apps/mobile` is the accessible Flutter source. External production/gateway records are not available and no live calls are authorized.

## Critical surfaces read successfully
- `supabase/functions/reconcile-payments/index.ts`
- `supabase/functions/verify-payment-webhook/index.ts`
- `supabase/functions/_shared/refunds.ts`
- `supabase/functions/_shared/reconcile-pending.ts`
- `supabase/functions/cancel-registration/index.ts`
- `supabase/functions/cancel-event/index.ts`
- `supabase/functions/check-in/index.ts`
- `supabase/functions/cashfree-webhook/index.ts`
- `supabase/functions/sync-payout-status/index.ts`
- `supabase/functions/issue-refund/index.ts`
- `supabase/migrations/202610220005_confirm_payment_no_resurrect_cancelled.sql`
- `supabase/migrations/202610290003_confirm_payment_refund_status.sql`
- `supabase/migrations/202610220004_refund_policy_integrity.sql`
- `supabase/migrations/202608170004_refund_idempotency.sql`
- `supabase/migrations/202608250001_check_in_rpc.sql`
- `supabase/migrations/202610090001_check_in_security.sql`
- `apps/mobile/lib/models/payment.dart`
- `apps/organizer-web/src/components/check-in/scan-modal.tsx`
- `apps/organizer-web/src/components/events/cancel-event-confirm-dialog.tsx`

## Coverage status
Phase 0 and targeted payment/reconciliation/check-in source mapping are in progress. Full database schema, all callers, admin UI, and complete test execution remain incomplete. Production financial reconciliation is blocked because no authorized Razorpay/Cashfree or production database evidence is available.
