# Reconciliation Invariants and Current Results

## Required invariants
1. A captured provider payment maps to exactly one payment row, registration, event, user, and organizer.
2. A provider refund maps to the exact captured payment and cumulative refunds do not exceed the captured amount.
3. A local processed refund has provider evidence; pending/failed/unknown are not displayed as completed.
4. Organizer wallet credits equal confirmed organizer shares less confirmed refund clawbacks and payout debits/refunds.
5. Every wallet mutation has an append-only audit/ledger record.
6. A payout is either provider-successful and locally success, or provider-terminal-failed and locally failed with exactly one wallet restoration; unresolved provider states remain liabilities.
7. Rebooking preserves independent registration/payment/refund history.

## Source-level results
- Invariants 1–3 have substantial controls: payment/order lookup, HMAC, dedup, claim machine, refund history archive. Runtime/provider reconciliation not executed.
- Invariant 4 is weakened by `refund_wallet_debit_failed`: customer refund can be marked issued while debit fails (`202610220004_refund_policy_integrity.sql:250-319`).
- Invariant 6 is violated by the 24-hour processing sweep calling `refund_wallet` without an authoritative Cashfree status check (`reconcile-payments/index.ts:517-540`).
- Invariant 7 is designed for via `payment_refund_history` (`202610220004_refund_policy_integrity.sql:49-106,273-285`), but no fixture executed.

## Safe reconciliation query plan (not executed)
Use a read-only database replica/local fixture to compare payment rows to registrations, refund history to provider refund IDs, wallet ledger entries to payment audit actions, and payout status transitions. Do not run against production without explicit authorization and a replica/snapshot.
