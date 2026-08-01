## Backlog

### MUST DO BEFORE LAUNCH
- **Restore withdrawal minimum ₹100 → ₹10000 paise**: Testing lowered
  `MIN_WITHDRAWAL_PAISE` in `supabase/functions/withdraw-wallet/index.ts` from `10000`
  to `100` (₹1). Revert to `10000` before any production launch, and restore the
  static hint text in `apps/organizer-web/src/components/payout/payout-section.tsx`
  ("Minimum withdrawal: ₹100 (10000 paise)").

### Pending (not blocking current tier)
- **Migrate Cashfree Payouts V1 → V2**: Cashfree warns V1 transfers APIs will be
  retired; plan migration to Transfers V2 (`_shared/cashfree.ts` + `withdraw-wallet`).
- **Add retry cap to reconcile-payments**: After N consecutive Razorpay unreachability
  failures (e.g., 10) or 24h stale, log a `payment_audit_log` entry for manual review
  instead of retrying indefinitely. File: `supabase/functions/reconcile-payments/index.ts`
