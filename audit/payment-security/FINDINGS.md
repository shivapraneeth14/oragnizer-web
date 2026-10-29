# Findings Register — Fresh Rescan

**Audit pass date:** 2026-10-30  
**Repository:** `/Users/shivapraneeth/Documents/community`  
**Branch/ref:** `dev`, `59eea61ddbb622d1fd11a42719c66c3da4e6ca30`  
**Status:** INCOMPLETE. No application, migration, production, or payout-feature changes were made.

Severity uses CRITICAL/HIGH/MEDIUM/LOW/INFO. “Confirmed” below means the source behavior is established; provider exposure and actual financial impact are separately stated.

## Active current and residual risks

### CASHFREE-001 — Legacy automated Cashfree payout path remains reachable despite the manual-payout requirement
- **Severity:** HIGH conditional; current workflow mismatch with potential external money movement.
- **Status:** POTENTIAL; provider deployment/secrets and production reachability are unverified.
- **Affected flow:** Organizer wallet debit → Cashfree transfer → payout status/refund/reconciliation.
- **Source evidence:** `supabase/functions/withdraw-wallet/index.ts:18-72,74-145` authenticates an owner, debits wallet through `initiate_wallet_withdrawal`, and calls Cashfree `/transfers`; `supabase/functions/cashfree-webhook/index.ts:12-138` and `supabase/functions/sync-payout-status/index.ts:95-205` remain deployed-configured function paths; `supabase/config.toml` includes these functions. The organizer UI explicitly says withdrawals are unavailable at `apps/organizer-web/src/components/payout/payout-section.tsx:222-231`, but the backend endpoint is not disabled by that UI.
- **Impact:** If Cashfree credentials and deployment routes remain active, an authenticated community owner can still initiate an automated external payout and legacy jobs can mutate wallet/payout records, contrary to the authoritative manual-payout model. Whether any hosted environment still has the required secrets is BLOCKED.
- **Reproduction:** Not run; no external provider calls permitted.
- **Recommended remediation:** Disable or gate all automated Cashfree transfer/status paths before introducing manual payout records. Preserve historical rows read-only and require an explicit migration/feature flag for any legacy recovery operation.

### PAYOUT-001 — 24-hour reconciliation refunds in-flight payout without authoritative provider status
- **Severity:** HIGH residual Cashfree path; impact unverified.
- **Status:** CONFIRMED — IMPACT UNVERIFIED; classify as legacy/reachable-until-disabled, not a current customer-payment-provider defect.
- **Source evidence:** `supabase/functions/reconcile-payments/index.ts:517-540` selects every `payout_items` row with local `status='processing'` older than 24 hours and calls `refund_wallet` without selecting or checking `cashfree_payout_id`. The same function’s earlier sweep at `:486-504` does distinguish a real `wd_` reference. `sync-payout-status/index.ts:30-92` provides an authoritative status lookup, but step 3b bypasses it.
- **Impact:** A successful or still-processing Cashfree transfer may have its wallet amount restored locally; a later success can leave both external payout value and restored wallet value. No production/provider exposure was demonstrated.
- **Remediation:** For any retained legacy records, query the provider and restore wallet only on explicit terminal failure; otherwise leave the amount in an unresolved liability state and alert.

### PAYOUT-004 — Cashfree SUCCESS webhook can win a stale read/write race against wallet restoration
- **Severity:** HIGH residual Cashfree path; impact unverified.
- **Status:** CONFIRMED — IMPACT UNVERIFIED; source race remains, runtime fixture BLOCKED.
- **Source evidence:** `supabase/functions/cashfree-webhook/index.ts:58-76` reads payout status without a row lock. Its SUCCESS branch only claws back when the snapshot is already `failed` (`:76-95`) and then unconditionally updates the row to `success` (`:97-106`). `supabase/migrations/202608170003_payout_status_sync.sql:23-72` shows the safer locked transition used by the poller. A concurrent `refund_wallet` can commit `failed` plus wallet credit after the webhook read but before the webhook update.
- **Impact:** Local state can say successful while the organizer wallet has already been restored. Actual exposure and frequency are unverified.
- **Remediation:** Disable legacy Cashfree processing or route every terminal transition through one locked, conditional RPC with a reconciliation/liability outcome.

### PAY-002 — Re-quote may return a Razorpay order after non-throwing payment-row persistence failure
- **Severity:** HIGH conditional; impact unverified.
- **Status:** CONFIRMED — IMPACT UNVERIFIED.
- **Source evidence:** `supabase/functions/create-payment/index.ts:313-330` updates an existing payment row after creating the Razorpay order but does not inspect the returned Supabase `error`; only the insert branch checks `insertError` at `:332-347`. The function returns the new order at `:356`. `clearRefundFieldsForRequote` is also awaited without inspecting its query result. Supabase query errors do not necessarily throw.
- **Impact:** A captured order can be returned to the customer while the current payment row still points to an old failed/refunded order, making later verification/refund recovery dependent on manual provider search.
- **Remediation:** Check every persistence result and fail closed. If an order already exists at the provider, place it in an explicit recovery queue rather than returning it as payable without a durable link.

### PAY-006 — Captured Razorpay payment ID persistence is not checked before confirmation
- **Severity:** HIGH conditional; impact unverified.
- **Status:** POTENTIAL; source path confirmed, failure injection not executed.
- **Source evidence:** `supabase/functions/verify-payment/index.ts:56-60`, `supabase/functions/verify-payment-webhook/index.ts:254-263`, `supabase/functions/create-payment/index.ts:78-93`, and `supabase/functions/cancel-event/index.ts:122-128` update `payments.razorpay_payment_id` without checking the returned error, then call `confirm_payment`. The effective `confirm_payment` definition in `supabase/migrations/202610290003_confirm_payment_refund_status.sql:118-135` marks the payment successful and credits the wallet without requiring a non-null provider payment ID.
- **Impact:** A non-throwing persistence failure can produce a locally successful/credited booking with no captured-payment identifier, preventing reliable refund issuance and provider reconciliation. Actual occurrence is unverified.
- **Remediation:** Persist and validate the provider capture identifier atomically with confirmation, or fail closed and queue the captured order for repair; add mocked non-throwing error tests.

### REF-001 — Customer refund can be issued while organizer wallet clawback fails
- **Severity:** MEDIUM.
- **Status:** CONFIRMED — IMPACT UNVERIFIED in production.
- **Source evidence:** `supabase/migrations/202610220004_refund_policy_integrity.sql:250-285` marks refund state and archives history; `:288-324` attempts `debit_wallet`, logs `refund_wallet_debit_failed` on error, and still returns issued success.
- **Impact:** Customer/provider refund truth and organizer wallet/payable balance can diverge until manual intervention. The audit row is useful evidence but is not an immutable liability/retry mechanism.
- **Remediation:** Record an immutable debit liability linked to the refund, exclude it from payable balance, and reconcile/retry until settled.

### AUTH-001 — Concurrent check-ins are not first-writer-wins at the database boundary
- **Severity:** MEDIUM.
- **Status:** CONFIRMED — IMPACT UNVERIFIED; source race, runtime fixture BLOCKED.
- **Source evidence:** `supabase/migrations/202610090001_check_in_security.sql:25-32,57-80` reads attendance and later updates by registration ID without a conditional `checked_in=false/status='confirmed'` predicate or affected-row branch. The older definition in `202608250001_check_in_rpc.sql:61-67` has the same pattern. Edge authorization remains in `supabase/functions/check-in/index.ts:47-103`.
- **Impact:** Two authorized concurrent scans can both return success while only one timestamp survives; no winner/duplicate event is recorded. No cross-organizer bypass was demonstrated.
- **Remediation:** Lock or conditionally update the row and return exactly one success; preserve the existing event-owner/team authorization and service-only RPC grant.

### PAYOUT-005 — Legacy Cashfree SUCCESS persistence errors are ignored after deduplication
- **Severity:** MEDIUM conditional.
- **Status:** POTENTIAL; legacy/reachable-until-disabled.
- **Source evidence:** `supabase/functions/cashfree-webhook/index.ts:46-55` records deduplication first; `:97-111` ignores errors from payout status and audit-log writes. In-flight updates at `:129-136` also ignore persistence errors.
- **Impact:** A provider success can be acknowledged while local status/audit evidence remains stale. No deployed failure fixture was run.
- **Remediation:** Disable the legacy path or make deduplication/application atomic and return retryable failure on persistence errors.

### FLUTTER-001 — Customer history displays creation time instead of authoritative capture/refund event time
- **Severity:** LOW.
- **Status:** CONFIRMED source/UI defect.
- **Source evidence:** `apps/mobile/lib/providers/activity_provider.dart:22-31` orders payments by `created_at`; `apps/mobile/lib/screens/my_payments_screen.dart:58-60,117-122` displays it; `apps/mobile/lib/screens/payment_detail_screen.dart:193-195` renders it; `apps/mobile/lib/models/payment.dart:1-20,44-73` has no captured timestamp.
- **Impact:** Delayed webhook/reconciliation can show an inaccurate payment date and weaken customer support/reconciliation. It does not change the financial amount.
- **Remediation:** Persist/expose distinct captured, refund-created, and refund-processed timestamps and render the authoritative event timestamp.

### MANUAL-001 — Manual payout workflow is not implemented
- **Severity:** INFO / product-control gap.
- **Status:** CONFIRMED missing capability, not a vulnerability.
- **Evidence:** Organizer UI only shows “Withdrawals are temporarily unavailable” (`apps/organizer-web/src/components/payout/payout-section.tsx:222-231`). No admin payout-recording UI, manual transfer RPC, organizer receipt-confirmation state, partial allocation model, dispute/retry state, or append-only manual-transfer evidence was found in `apps/admin-web/src`, `apps/organizer-web/src`, `supabase/functions`, or migrations. Existing `payout_items` and Cashfree fields are provider-oriented (`202607280002_wallet_and_payouts.sql:5-20`).
- **Impact:** There is no authoritative way to record an admin transfer, obtain organizer confirmation, calculate pending/confirmed/outstanding amounts, or reconcile a manual transfer to one or more events. Existing automated Cashfree paths must not be mistaken for the requested manual design.
- **Future design requirements:** immutable payout record and audit evidence, admin authorization, idempotency/duplicate prevention, pending/confirmed/disputed states, partial event allocation, retry/interruption recovery, receipt confirmation, and derived outstanding balance.

## Previous-finding disposition history

| Prior ID | Current disposition | Reason and current evidence |
|---|---|---|
| PAYOUT-001 | **CONFIRMED — IMPACT UNVERIFIED** | The unsafe 24-hour `refund_wallet` path remains at `reconcile-payments/index.ts:517-540`; reclassified as residual Cashfree/legacy because customer payments are Razorpay and intended payouts are manual. |
| AUTH-001 | **CONFIRMED — IMPACT UNVERIFIED** | Same unlocked read/unconditional update remains in final check-in SQL; no disposable DB concurrency test. |
| REF-001 | **CONFIRMED — IMPACT UNVERIFIED** | Current refund RPC still returns issued after logging a wallet-debit failure. |
| FLUTTER-001 | **CONFIRMED** | Current Flutter model and screens still use `created_at`; no captured timestamp exists. |
| PAY-002 | **CONFIRMED — IMPACT UNVERIFIED** | Existing-payment re-quote update still ignores returned persistence error. |
| PAY-003 | **INVALIDATED** | The prior citation treated the idempotency key as registration-only. Current `create-payment/index.ts:28-32,303-310` calls `createRazorpayOrder(finalAmount, \`${registrationId}_${attemptCount}\`)`; the passed value includes the attempt in both key and receipt. Provider semantics were not exercised, but the cited source defect is no longer present. |
| PAYOUT-004 | **CONFIRMED — IMPACT UNVERIFIED** | The stale SUCCESS read/write race remains in the legacy Cashfree webhook; runtime race fixture unavailable. |
| PAYOUT-005 | **POTENTIAL** | Unchecked Cashfree writes remain, but Cashfree is not the customer-payment provider and deployment reachability is unverified. |
| SAFE-001 | **VERIFIED SAFE at source level** | `cancel-registration/index.ts:66-73` rejects exactly 24 hours or less; cancellation guards remain in `202610290003_confirm_payment_refund_status.sql:54-84`. Production/provider behavior remains unverified. |

## Provider classification

- **Current customer-payment provider:** Razorpay, evidenced by Flutter checkout (`apps/mobile/lib/screens/event_detail_screen.dart:675-755`) and Razorpay order/refund/webhook functions.
- **Cashfree:** residual payout beneficiary, transfer, webhook, poller, cron, schema, and UI/legal references. The UI payout action is disabled, but backend endpoints and migration-scheduled jobs remain reachable in source. Hosted secrets, deployed cron rows, and historical rows were not accessible.
- No Cashfree customer-payment path was found in the inspected checkout/refund lifecycle.

## Validation-phase disposition

The executed eight-test source-model phase supports the source traces but does not upgrade deployment or impact certainty:

- **PAY-006, REF-001, PAYOUT-004, AUTH-001:** modeled fixtures reproduced the documented unsafe state/interleaving; no Edge Function, SQL transaction, row lock, or concurrent database execution occurred. Existing statuses remain unchanged.
- **Repeat booking and organizer cancellation:** modeled fixtures produced the intended distinct-history and attendee eligibility results. End-to-end database/provider behavior remains unverified.
- **Cross-organizer authorization:** modeled mismatch was denied before the RPC, consistent with source checks. No HTTP/RLS runtime test was run.
- **CASHFREE-001:** the inventory test found residual transfer, webhook, poller, cron, reconciliation, and environment references. This proves source reachability only; deployed routes, secrets, cron rows, and historical records remain unknown.

No finding is marked fixed based on these tests. No new production exposure is claimed.

## Runtime blocker diagnosis

The runtime blocker is environmental, not evidence that the application or migrations are safe. Docker is now healthy: client/server `29.4.3`, Compose `v5.1.3`, Docker Desktop `4.73.0`, and `desktop-linux` context all respond. The installed Supabase CLI package is version `2.105.0`, but its arm64 binary still terminates with `SIGKILL` before producing version/status output. No finding is reclassified or marked fixed; the required next action is a user-approved version-pinned CLI repair, followed by a fresh unlinked local Supabase project and rerun of the isolated migration/integration phase.

## Real runtime validation disposition

The isolated runtime attempt did not produce application integration evidence. Docker/Supabase was unavailable. A new temporary PostgreSQL cluster was safely created and destroyed, but the 133-file migration chain stopped at the first migration because the plain cluster lacks the Supabase `auth` schema (`202607220001_initial_schema.sql:31`). Consequently, no finding is reclassified or marked fixed: database lifecycle, payout/refund race, check-in concurrency, persistence-failure, and server-side cross-organizer runtime behavior remain unverified or blocked as recorded in the matrix.

The minimally invasive repair was proposed but not executed: a clean `supabase@2.122.0` install into `$HOME/.claude/tools/supabase-2.122.0`. The session policy blocked the external package download/execution. This changes no finding disposition; a working CLI supplied or installed by the user is required before runtime validation can resume.
