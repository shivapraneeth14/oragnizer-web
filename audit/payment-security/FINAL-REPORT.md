# Final Report — CLUVO Payment and Financial Security Rescan

## Status

**INCOMPLETE.** This fresh source-led rescan does not establish production financial correctness. Critical runtime validations remain blocked by the unavailable Docker/local Supabase runtime, and no authorized hosted database, provider dashboard, production logs, or provider calls were used. No application code, SQL migration, production configuration, or manual payout feature was implemented or changed.

## Executive summary

The current customer payment path is Razorpay: Flutter requests a server-created order, opens Razorpay Checkout, and backend verification/webhooks use HMAC, event deduplication, provider lookup, terminal-state guards, and claim-guarded refunds. The current source also preserves refund history for payment-row reuse and enforces the 24-hour customer cancellation rule server-side.

The repository nevertheless contains a substantial residual Cashfree payout subsystem. It includes authenticated transfer initiation, beneficiary management, webhook and polling functions, wallet debit/refund RPCs, Cashfree-specific schema, organizer status UI, and cron definitions. The visible organizer UI says withdrawals are unavailable, but that is not a backend disablement. Because the requested workflow is manual organizer payouts, Cashfree must be treated as reachable legacy automation until hosted routes, secrets, cron rows, and historical records are verified and disabled or explicitly isolated.

The highest unresolved risks are:

1. Legacy Cashfree reconciliation can restore a wallet for a processing payout without provider status, and the Cashfree SUCCESS webhook has a stale read/write race that can overwrite a concurrent wallet refund.
2. Payment persistence errors are not consistently checked before confirmation. A captured Razorpay payment ID can be absent while `confirm_payment` still credits the organizer wallet, and a re-quote can return a provider order without durable payment-row linkage.
3. Refund completion can mark customer/provider refund truth as issued while organizer wallet clawback fails; the system logs this but does not create a payable liability/retry record.
4. Concurrent authorized ticket scans are not first-writer-wins at the SQL mutation boundary.
5. Flutter payment history shows creation time, not an authoritative capture/refund event timestamp.
6. The requested manual payout workflow is absent: no admin transfer recording, organizer receipt confirmation, partial allocation, dispute/retry state, or immutable manual settlement ledger was found.

## Active findings

| ID | Severity | Status | Financial/security exposure |
|---|---|---|---|
| CASHFREE-001 | HIGH conditional | POTENTIAL | Legacy Cashfree transfer endpoint and status paths remain source-reachable; hosted exposure unverified |
| PAYOUT-001 | HIGH | CONFIRMED — IMPACT UNVERIFIED | 24h local wallet restoration can precede provider truth |
| PAYOUT-004 | HIGH | CONFIRMED — IMPACT UNVERIFIED | Stale Cashfree SUCCESS can coexist with wallet restoration |
| PAY-002 | HIGH | CONFIRMED — IMPACT UNVERIFIED | Re-quote order may be returned without persisted linkage |
| PAY-006 | HIGH conditional | POTENTIAL | Captured order may be locally confirmed without persisted provider capture ID |
| REF-001 | MEDIUM | CONFIRMED — IMPACT UNVERIFIED | Refund and organizer wallet can diverge |
| AUTH-001 | MEDIUM | CONFIRMED — IMPACT UNVERIFIED | Concurrent scans can both report success |
| PAYOUT-005 | MEDIUM conditional | POTENTIAL | Legacy Cashfree success writes are not checked after dedupe |
| FLUTTER-001 | LOW | CONFIRMED | Customer-visible payment date is not capture time |
| MANUAL-001 | INFO | CONFIRMED GAP | Manual payout workflow is not implemented |

## Previous findings reclassified

- **PAY-003 INVALIDATED:** current `create-payment` passes registration ID plus `attempt_count` into order creation (`create-payment/index.ts:303-310`); the prior registration-only idempotency citation no longer matches current source.
- **PAYOUT-001/PAYOUT-004/PAYOUT-005 retained but reclassified as residual Cashfree risk:** Cashfree is not the customer payment provider, but its payout/webhook/cron paths remain present and potentially reachable. They are not removed merely because the product requirement changed.
- **AUTH-001, REF-001, FLUTTER-001, PAY-002 remain active:** the cited source behavior remains in current code.
- **SAFE-001 remains verified safe at source level:** the 24-hour customer cancellation boundary and cancelled-registration/event guards remain present. This is not production proof.

## Verified versus unverified claims

### Verified by source or local tests

- Razorpay is the Flutter customer payment provider.
- Razorpay HMAC verification and webhook deduplication are present.
- Refund claims use an atomic claim/recovery path and archived history.
- Customer cancellation rejects at exactly 24 hours or less on the backend.
- Organizer cancellation checks community owner/team/admin authorization and excludes attended registrations from refunds.
- Check-in edge authorization resolves the event before calling a service-only RPC; no cross-organizer bypass was demonstrated statically.
- 36 targeted Deno tests and 19 targeted Flutter tests passed locally.

### Source-established but runtime-unverified

- Cashfree payout safety-net and webhook race conditions.
- Payment-row and capture-ID persistence failure paths.
- Refund/wallet divergence when debit fails.
- Concurrent check-in duplicate success.
- Booking A → Refund A → Booking B → Refund B end-to-end behavior.
- Effective hosted migration/RLS/grant/cron state.
- Actual provider or production financial impact.

## Coverage and limitations

Inspected: Flutter mobile checkout/history/cancellation/model, organizer payout and payment-account UI, admin source inventory, Razorpay order/verification/refund/webhook functions, Cashfree payout/beneficiary/webhook/poller functions, cancellation/check-in functions, shared refund/reconciliation helpers, relevant migration redefinitions, wallet/ledger/statement SQL, cron definitions, tests, and provider configuration references.

Not available: disposable Postgres/Supabase because Docker was unavailable; hosted Supabase schema and cron rows; Razorpay/Cashfree records; production ledger exports; provider sandbox calls; concurrent DB fixtures. Delegated agents failed upstream before returning evidence, so all conclusions in these artifacts come from direct reads and executed local tests.

## Proposed remediation plan (not approved or implemented)

1. Freeze/disable residual Cashfree transfer and status mutation paths under the manual-payout decision; verify and rotate any historical cron/provider secrets.
2. Define the manual payout model: immutable payout intent, admin authorization, amount and event allocations, pending/confirmed/disputed/reversed states, organizer receipt confirmation, evidence/reference, duplicate idempotency, partial payouts, retry/interruption handling, and derived outstanding balance.
3. Make provider capture-ID and payment-row persistence atomic/fail-closed before wallet credit or customer success; add repair queue for a provider-captured but locally unlinked order.
4. Replace legacy payout refund heuristics with provider-authoritative/explicit-liability handling, or remove the subsystem from active deployment.
5. Represent refund clawback failure as an immutable liability excluded from payable balance until reconciled.
6. Make check-in mutation conditional/locked and add a real concurrent regression test.
7. Add authoritative capture/refund timestamps to backend contracts and Flutter/React displays.

## Approval gates before implementation

Do not approve implementation from this report alone. First provide:

- A disposable isolated Supabase/Postgres runtime or equivalent owner-observed validation environment.
- Effective migration-chain schema, RLS, grants, triggers, and cron inspection.
- Local fixtures for repeat booking/refunds, organizer cancellation, payout/refund race, concurrent check-in, cross-organizer authorization, and non-throwing persistence failures.
- Authorized read-only hosted/provider evidence establishing whether Cashfree routes, secrets, cron jobs, and historical payout rows remain active.
- Product approval of manual payout states, authorization, receipt confirmation, allocation, dispute, and reconciliation invariants.

Until those gates are satisfied, the audit remains incomplete and the platform should not be represented as financially reconciled or ready for the requested manual payout workflow.

## Validation-phase result

A safe source-model phase was executed from `/Users/shivapraneeth/.claude/projects/validation-phase-20261030.test.ts`: **8 passed, 0 failed** after correcting one overly specific multiline source assertion. The fixtures covered provider-ID persistence failure before confirmation, refund success with wallet-debit failure, delayed Cashfree SUCCESS versus wallet restoration, repeat booking/refund history, organizer cancellation eligibility, concurrent check-in modeling, cross-organizer authorization modeling, and Cashfree reachability inventory.

The result is intentionally limited. The tests used repository reads and in-memory state models; they did not invoke an Edge Function, execute a migration, evaluate RLS or grants, run a Postgres transaction, create real concurrency, call Razorpay/Cashfree, inspect a hosted deployment, or access financial data. They support the source findings but do not prove runtime occurrence or production impact. The audit remains **INCOMPLETE**.

## Manual organizer payout proposal (product design only; not implemented)

The intended manual workflow should be an append-only settlement process, separate from legacy Cashfree transfer functions:

1. **Intent and authorization:** an admin creates a payout intent for one organizer/community with a server-calculated eligible amount and idempotency key. Require second-admin approval above a configured threshold; organizers cannot create or approve their own payout.
2. **Allocation:** immutable lines allocate the intent to events or settlement periods. Partial payouts use multiple lines; remaining balance is derived from eligibility, allocations, clawbacks, and settled debits rather than manually overwritten.
3. **States:** `draft`, `approved`, `transfer_pending`, `transfer_recorded`, `organizer_confirmed`, `disputed`, `reconciliation_required`, `reversed`, and `cancelled`. Transitions are append-only and server-validated.
4. **Evidence:** record rail, external reference, transfer date, amount, destination-account fingerprint (not raw sensitive account data), receipt/document reference, operator, and idempotency key. Duplicate or interrupted submission must be retryable without a second settlement.
5. **Organizer confirmation/dispute:** the organizer confirms receipt or opens a reasoned dispute with evidence. Confirmation does not alter immutable transfer amount. Disputes pause settlement and require an auditable admin resolution.
6. **Failures/reversals:** provider or recording failures remain retryable; duplicate references or amount mismatches enter reconciliation rather than creating a second payout. Reversal is a new compensating record linked to the original.
7. **Outstanding payable:** derive by organizer/event and cutoff. Pending, disputed, and unresolved refund clawbacks require explicit treatment and must not silently disappear from payable calculations.
8. **Audit/reconciliation:** every action stores actor, timestamp, prior/new state, reason, idempotency key, and immutable event log. Reconcile wallet statement, event allocations, payment/refund history, and transfer evidence without storing secrets.

Product approval is required for approval thresholds, eligibility cutoff, organizer confirmation and dispute SLA, allocation order, unresolved clawback treatment, supported rails, reversal authority, and retention/redaction. This proposal introduces no schema, UI, RPC, migration, or feature.

## Real isolated runtime validation result

The next audit phase was attempted with isolation controls. Docker was unavailable and `supabase status` could not access its CLI binary. The existing Homebrew PostgreSQL server was inspected read-only but not used because it contained pre-existing databases. A separate temporary PostgreSQL 16 cluster was initialized with a private Unix socket, local-only binding, synthetic empty database, and verified teardown.

A migration-chain preflight enumerated **133** files and stopped at `202607220001_initial_schema.sql:31` with `ERROR: schema "auth" does not exist`. No migration was edited to bypass this dependency. No effective Supabase schema was available, so repeat booking/refund, organizer cancellation, persistence-failure integration, payout/refund overlap, concurrent check-in, and server-side cross-organizer HTTP/RLS tests were not executed and remain **BLOCKED**. Production/provider reconciliation remains blocked and untouched.

This phase produced an isolation-setup result and a precise migration blocker, not integration, database, concurrency, or production passes. The audit remains **INCOMPLETE**; no finding is fixed or approved for remediation based on this attempt.

## Docker and Supabase CLI diagnosis

- Docker CLI is installed (`29.4.3`, Compose `v5.1.3`) and the `desktop-linux` context is selected, but the Docker Desktop engine is stopped and `/Users/shivapraneeth/.docker/run/docker.sock` is unavailable.
- Docker Desktop is installed, but the permitted start attempt was denied because it would launch a persistent background service. No workaround was used.
- Supabase CLI package `2.105.0` is installed globally with an arm64 binary, but `supabase --version` and `supabase status` terminate with `SIGKILL` before output. No reinstall or package mutation was performed.
- Docker is now healthy, but the next required action remains user-controlled: repair/reinstall or provide a working version-pinned Supabase CLI. Only after `supabase --version` succeeds should a fresh disposable local Supabase project be initialized. Existing Docker containers and volumes must remain untouched.

## Current environment recheck

- Docker client/server: `29.4.3`; API `1.54`; Docker Desktop `4.73.0 (226246)`; Compose `v5.1.3`; context `desktop-linux`; engine status `running`.
- Node: `v22.23.0`; npm: `10.9.8`; Deno: `2.9.8`.
- Supabase package: `2.105.0`, arm64 binary installed, but `supabase --version` and `supabase status` still terminate with `SIGKILL` before output.
- Read-only Docker inventory found unrelated running containers and existing volumes. They were not used, inspected internally, stopped, or removed.
- No local Supabase project was initialized and no migration/test was run in this recheck. The audit remains **INCOMPLETE**.
- The proposed isolated repair (`supabase@2.122.0` in `$HOME/.claude/tools/supabase-2.122.0`) was not executed because the session policy denied downloading and executing external package code. No package, cache, symlink, Docker resource, database, or project configuration changed.

The safe next action is for the user to run the exact pinned install command outside the restricted session or provide a verified absolute CLI binary. Runtime testing must remain blocked until that binary returns valid version/help output.
