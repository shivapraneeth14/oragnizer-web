# Regression and Remediation Safety

## PAYOUT-001
- Violated invariant: unresolved provider payout must not be refunded locally.
- Affected callers: reconcile cron, Cashfree webhook, sync poller, organizer wallet/payout UI.
- Minimum fix: route 24h processing rows through the same authoritative Cashfree status query and guarded `sync_payout_status_update`; only terminal provider failure may call `refund_wallet`.
- Regression tests: real provider ID + delayed SUCCESS; provider PROCESSING; status lookup timeout; webhook/poller race; duplicate failure event; late success after refund.
- Deployment: deploy function before/with migration only if no schema dependency; keep existing `refund_wallet` idempotency; review historical processing rows before rollout.

## AUTH-001
- Violated invariant: one ticket can be accepted once atomically.
- Minimum fix: conditional UPDATE and affected-row branch or row lock; preserve event ownership authorization and service-only RPC grant.
- Regression tests: two concurrent calls; duplicate scan after success; wrong organizer; cancelled/refunded ticket; event ended.

## REF-001
- Violated invariant: organizer payable balance must reflect customer refund clawback.
- Minimum fix: append immutable debit-liability record and retry/reconcile path; never overwrite history or mark unresolved amount payable.
- Regression tests: debit success, insufficient wallet, refund success with debit failure, retry after wallet top-up, duplicate retry, payout interaction.

## Existing safeguards to preserve
- Razorpay signature/deduplication.
- Provider re-check before stale refund retry.
- Cancel-before-refund ordering for customer cancellation.
- Cancelled registration/event guards in `confirm_payment`.
- Service-only check-in RPC grant and edge authorization.
