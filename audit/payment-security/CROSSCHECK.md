# Cross-System Cross-Checks

## Payment / refund
- Razorpay webhook signature and deduplication: present in `verify-payment-webhook/index.ts:15-20,189-231`.
- Provider-state recovery: present in `_shared/refunds.ts:237-288` and `_shared/reconcile-pending.ts:87-149`.
- Database terminal guard: present in `202610290003_confirm_payment_refund_status.sql:48-66`.
- Frontend organizer cancellation calls `cancel-event` and surfaces failed count (`cancel-event-confirm-dialog.tsx:52-86`), but UI summary only reads confirmed/success rows at `:22-42`; it is informational and can be stale by confirmation time.

## Wallet / payout
- Refund completion writes payment/provider truth before wallet debit and logs debit failure (`202610220004_refund_policy_integrity.sql:250-319`). This is explicit divergence requiring liability/retry reconciliation.
- Payout status webhook and poller use guarded `sync_payout_status_update` for provider terminal failures, but reconcile step 3b bypasses provider status and directly calls `refund_wallet` after 24h (`reconcile-payments/index.ts:517-540`).

## Ticket authorization
- Web scanner submits opaque QR to backend (`scan-modal.tsx:65-68,85-90`).
- Edge function resolves QR → event → community and checks owner/team/admin before invoking service-only RPC (`check-in/index.ts:47-107`).
- Direct authenticated RPC execution is revoked in final migration (`202610090001_check_in_security.sql:86-87`).
- Remaining gap is concurrency/atomic attendance mutation, not a demonstrated cross-organizer bypass.

## Flutter
- Flutter source is present; `apps/mobile/lib/models/payment.dart:1-92` models provider IDs, refund fields, and local timestamps. Full payment service/history caller trace is pending.

## External evidence
No deployed configuration, gateway dashboard, production database, or logs were accessed. Claims about actual exposure remain unverified.
