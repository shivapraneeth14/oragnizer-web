# Master Findings Registry: Cluvo Stage 6

This document provides the definitive, end-to-end catalog and status of all security, architectural, concurrency, and financial integrity findings identified and addressed during Cluvo Stage 6.

Every finding has been independently audited, remediated in source code, and verified through live physical PostgreSQL concurrency executions and automated integration tests.

---

## Findings Summary Matrix

| ID | Domain | Title | Severity | Remediation Artifacts | Final Status |
| :--- | :--- | :--- | :---: | :--- | :---: |
| **REF-001** | Payments & Refunds | Non-Atomic Registration Cancellation & Duplicate Capacity Decrement | **CRITICAL** | `202611010014`, `issue-refund` | **RESOLVED & VERIFIED** |
| **REF-002** | Check-In & Gate | Attended Attendee Cancellation & Unauthorized Refund Claim | **HIGH** | `202611010014`, `claim_payment_refund` | **RESOLVED & VERIFIED** |
| **REF-003** | Admin & Settlements | Unverified Offline Settlements & Missing Deduplication | **HIGH** | `202611010015`, `RefundManualReviewModal` | **RESOLVED & VERIFIED** |
| **REF-004** | Security & Tickets | Sequential Insecure Ticket Tokens & Webhook Replay Token Rotation | **HIGH** | `202611010016`, `confirm_payment` | **RESOLVED & VERIFIED** |
| **REF-005** | Mobile UX & Routing | Deep-Link Route Failures & Ambiguous Refund Detail Navigation | **MEDIUM** | Flutter `app.dart`, `my_payments_screen` | **RESOLVED & VERIFIED** |
| **REV-REF-001**| Database Concurrency | Lock-Order Inversion Deadlock (Reverse Level 2 / Level 3 Row Locks) | **CRITICAL** | Global Hierarchy (`events` $\to$ `reg` $\to$ `pay`) | **RESOLVED & VERIFIED** |
| **REV-REF-002**| Security & Provider | Missing Server-Side Razorpay Provider Verification for Refund Adoption | **HIGH** | Edge Function `admin-adopt-refund` | **RESOLVED & VERIFIED** |
| **REV-REF-003**| Business Invariant | Admin Refund Adoption & Manual Settlement Bypassed Attended Ticket Check | **HIGH** | `202611010015` Attended Gate in Admin RPCs | **RESOLVED & VERIFIED** |
| **REV-REF-004**| Admin Validation | Frontend Form Validation Mismatches & Duplicate UTR Reference Collision | **MEDIUM** | `RefundManualReviewModal`, Unique Indexes | **RESOLVED & VERIFIED** |
| **REV-REF-005**| Verification Rigor | Mock/Static-Only Tests Without Multi-Connection Database Concurrency | **MEDIUM** | `stage6_db_concurrency_test.cjs` | **RESOLVED & VERIFIED** |
| **VER-MS-001**| Schema Compatibility | Reintroduction of Non-Existent `profiles.phone` Column in Statements | **CRITICAL** | `202611010017` Lines 692 & 779 (`NULL::TEXT`) | **RESOLVED & VERIFIED** |
| **VER-MS-002**| PostgREST RPC | Parameter Key Mismatch in `admin_cancel_manual_payout` Call | **HIGH** | `PayoutDisputeResolutionModal.tsx` | **RESOLVED & VERIFIED** |
| **VER-MS-003**| Financial Display | Unconstrained KPI Accumulator Inflating `payoutsPending` on Cancelled | **MEDIUM** | `FinancialsPage.tsx` Payout Status Switch | **RESOLVED & VERIFIED** |

---

## Detailed Finding Dossiers

### REF-001: Non-Atomic Registration Cancellation & Duplicate Capacity Decrement
- **Severity**: **CRITICAL**
- **Impact**: In distributed execution, a customer or admin cancelling a registration while refunding could result in partial success (ticket cancelled without refund claim, or capacity decremented multiple times during concurrent retries).
- **Root Cause**: Registration cancellation and refund claim were handled in separate database transactions without atomic coordination.
- **Remediation**:
  - Implemented PostgreSQL composite function `cancel_registration_and_claim_refund` in migration `202611010014_atomic_cancel_and_claim_refund.sql`.
  - Atomically locks event, registration, and payment records in a single transaction.
  - Updates registration status to `'cancelled'`, zeroes out ticket QR code, and transitions `payments.refund_claim_state` to `'claimed'`.
  - Atomically decrements `events.booked_count` by 1 and guards against secondary decrements using conditional logic (`IF NOT v_reg_already_cancelled`).
- **Verification**: Verified via physical multi-connection Node.js concurrency tests (`tests/stage6_db_concurrency_test.cjs`). Duplicate calls cleanly return `already_cancelled` and preserve exact capacity counts.

---

### REF-002: Attended Attendee Cancellation & Unauthorized Refund Claim
- **Severity**: **HIGH**
- **Impact**: Attendees who physically checked into an event could submit refund requests or have their registrations cancelled, resulting in financial loss for organizers.
- **Root Cause**: Cancellation and refund routines only checked `registrations.status`, omitting the `checked_in` flag.
- **Remediation**:
  - Added strict attended check `IF v_reg.checked_in THEN RAISE EXCEPTION 'not_refundable_attended'` inside:
    - `public.cancel_registration_and_claim_refund`
    - `public.claim_payment_refund`
    - `public.cancel_registration_and_decrement`
- **Verification**: Verified in `tests/stage6_db_concurrency_test.cjs` (Section 2). Attended ticket cancellation attempts were rejected with `not_refundable_attended`, ticket QR code remained intact, and booked count was unchanged.

---

### REF-003: Administrative Manual Settlement & Provider Refund Adoption Reconciliation
- **Severity**: **HIGH**
- **Impact**: When automated refund processing failed, admins lacked structured, auditable tools to reconcile settlements manually or adopt external provider refunds into the passbook ledger.
- **Root Cause**: No dedicated administrative procedures existed to record offline bank/UPI settlements or record provider-side refund IDs with immutable audit logging.
- **Remediation**:
  - Created `public.admin_manual_settlement` and `public.admin_adopt_provider_refund` in migration `202611010015_verified_admin_refund_resolution.sql`.
  - Structured evidence validation (settlement method in `bank_transfer`, `upi`, `cash`, `other`; reference number $\ge 10$ chars; notes $\ge 20$ chars).
  - Cross-payment duplicate check on external references and provider refund IDs.
  - Append-only recording in `public.payment_audit_log` and `public.payment_refund_history`.
- **Verification**: Verified with test suite asserting deduplication, format validation, and ledger credit updates.

---

### REF-004: Sequential Insecure Ticket Tokens & Webhook Replay Token Rotation
- **Severity**: **HIGH**
- **Impact**: Ticket validation tokens could be predicted if sequential or timestamp-based, and repeated Razorpay payment webhooks could rotate the attendee's issued QR token, invalidating tickets already in attendee hands.
- **Root Cause**: Token generation lacked cryptographic CSPRNG and payment confirmation logic blindly updated ticket tokens on repeated `payment.captured` webhooks.
- **Remediation**:
  - Deployed `202611010016_cryptographic_ticket_token.sql`.
  - Generates ticket tokens using `gen_random_bytes(32)` providing 256 bits of cryptographic entropy, prefixed with `cluvo_` and hashed with SHA-256.
  - In `confirm_payment`, wrapped token generation in `COALESCE(qr_code, ...)` so webhook replays on confirmed registrations do not rotate the existing token.
- **Verification**: Tested in `tests/stage6_db_concurrency_test.cjs` (Section 6). Generated tokens verified to have `cluvo_` prefix and 64 hex characters. Webhook replay verified zero token rotation.

---

### REF-005: Mobile Deep-Linking & Historical Refund Isolations
- **Severity**: **MEDIUM**
- **Impact**: Mobile attendees tapping refund notifications or viewing payment details could encounter broken routes or ambiguous status screens between active payments and archived refund receipts.
- **Root Cause**: GoRouter route definitions in `apps/mobile/lib/app.dart` lacked dedicated `/refunds/:id` routing, and payment detail screens did not cleanly branch between active tickets and historical refund receipts.
- **Remediation**:
  - Registered `/refunds/:id` and `/payments/:id` in `apps/mobile/lib/app.dart`.
  - Updated `my_payments_screen.dart` and `payment_detail_screen.dart` to isolate historical refund receipts from active registrations.
- **Verification**: Flutter widget and routing unit tests in `apps/mobile/test/refund_detail_navigation_test.dart` passed 3/3.

---

### REV-REF-001: Database Lock-Order Inversion Deadlock
- **Severity**: **CRITICAL**
- **Impact**: Concurrent customer cancellations and attendee check-ins or booking reservations produced PostgreSQL 40P01 deadlock exceptions when transactions acquired locks in opposing order.
- **Root Cause**: In booking flows, locks were acquired: `events` $\to$ `registrations` $\to$ `payments`. In older cancellation flows, locks were acquired: `payments` $\to$ `registrations` $\to$ `events`.
- **Remediation**:
  - Standardized the global lock hierarchy across all PostgreSQL procedures:
    - **Level 1**: Community row lock (`SELECT ... FROM communities WHERE id = ... FOR NO KEY UPDATE`)
    - **Level 2**: Event row lock (`SELECT ... FROM events WHERE id = ... FOR NO KEY UPDATE`)
    - **Level 3**: Registration row lock (`SELECT ... FROM registrations WHERE id = ... FOR UPDATE`)
    - **Level 4**: Payment row lock (`SELECT ... FROM payments WHERE id = ... FOR UPDATE`)
    - **Level 5**: Payout item row lock (`SELECT ... FROM payout_items WHERE id = ... FOR UPDATE`)
- **Verification**: Verified under multi-connection concurrent execution in `tests/stage6_db_concurrency_test.cjs`. Zero 40P01 deadlocks observed.

---

### REV-REF-002: Missing Server-Side Razorpay Provider Verification for Refund Adoption
- **Severity**: **HIGH**
- **Impact**: An administrative user could adopt a fabricated or pending Razorpay refund ID into Cluvo without verifying its validity against the Razorpay Payments API.
- **Root Cause**: Client-side admin modal called database RPC directly without server-side verification.
- **Remediation**:
  - Built Supabase Edge Function `admin-adopt-refund`.
  - Enforces caller authentication and verifies caller is an active platform administrator in `profiles`.
  - Queries Razorpay Payments API (`/v1/payments/:pay_id/refunds/:rfnd_id`).
  - Verifies refund belongs to the target payment, currency is `INR`, refund amount matches exactly, and status is `processed`.
  - Only on verified provider confirmation does it invoke the internal database adoption RPC.
- **Verification**: Verified across 10 mock scenarios in `tests/stage6_refund_remediation.test.ts`.

---

### REV-REF-003: Admin Refund Functions Bypass Attended Ticket Protection
- **Severity**: **HIGH**
- **Impact**: Admins using manual review could inadvertently adopt refunds or settle tickets for attendees who were already admitted to the venue.
- **Root Cause**: `admin_adopt_provider_refund` and `admin_manual_settlement` lacked an attended ticket validation guard.
- **Remediation**:
  - Integrated `IF v_reg.checked_in THEN RAISE EXCEPTION 'not_refundable_attended'` into both administrative settlement RPCs in migration `202611010015`.
- **Verification**: Verified in `tests/stage6_db_concurrency_test.cjs` (Section 2).

---

### REV-REF-004: Manual Settlement UI Validation Mismatch & Duplicate Reference Reuse
- **Severity**: **MEDIUM**
- **Impact**: Admin UI allowed submission of notes with length $\ge 10$, while PostgreSQL enforced $\ge 20$, causing opaque RPC validation failures. Furthermore, reference numbers could collide across payments.
- **Root Cause**: Frontend modal validation schema was out of sync with database constraints, and unique constraint on offline references was missing.
- **Remediation**:
  - Aligned `RefundManualReviewModal.tsx` validation with PostgreSQL: reference $\ge 10$ alphanumeric chars, notes $\ge 20$ chars.
  - Added unique partial index `idx_payment_audit_manual_settlement_ref` ensuring reference numbers cannot be reused across distinct manual settlements.
- **Verification**: Tested in `apps/admin-web/src/components/RefundManualReviewModal.test.tsx` (9/9 passed) and `tests/stage6_db_concurrency_test.cjs`.

---

### REV-REF-005: Static-Only Verification Instead of Live Physical Database Execution
- **Severity**: **MEDIUM**
- **Impact**: Unit tests with mocked databases could not detect real PostgreSQL deadlocks, row-lock serialization behavior, or schema syntax errors.
- **Root Cause**: Previous verification suites used only in-memory mocks.
- **Remediation**:
  - Developed end-to-end multi-connection Node.js verification test harness connecting directly to isolated PostgreSQL (`cluvo_test_stage6`).
  - Implemented explicit lock contention tests monitoring `pg_stat_activity` and `pg_blocking_pids()`.
- **Verification**: Complete multi-client execution logs recorded in `tests/stage6_db_concurrency_test.cjs` and `tests/stage6_manual_settlement_test.cjs`.

---

### VER-MS-001: Reintroduction of Non-Existent `profiles.phone` Column in Statements
- **Severity**: **CRITICAL**
- **Impact**: Any admin or organizer viewing financial statements or passbook ledgers in production would trigger a fatal database error (`ERROR: column prof.phone does not exist`), breaking all financial dashboard pages.
- **Root Cause**: Migration `202611010017` inadvertently restored an old query definition that joined `profiles.phone`, which does not exist in the Cluvo schema.
- **Remediation**:
  - Corrected lines 692 and 779 of `supabase/migrations/202611010017_concurrency_safe_manual_settlements.sql` to select `NULL::TEXT AS attendee_phone`.
  - Added regression assertions to `supabase/tests/migration_gate.test.ts`.
- **Verification**: Verified against `cluvo_test_stage6` without `profiles.phone`. `get_admin_financial_statement` and `get_organizer_financial_statement` executed cleanly.

---

### VER-MS-002: Parameter Key Mismatch in `admin_cancel_manual_payout` Call
- **Severity**: **HIGH**
- **Impact**: Admin attempting to cancel an unconfirmed pending settlement in the admin UI encountered a 400 Bad Request error from PostgREST because the RPC argument name did not match.
- **Root Cause**: `PayoutDisputeResolutionModal.tsx` sent `{ p_cancellation_notes: ... }`, whereas PostgreSQL function `admin_cancel_manual_payout` declared `p_cancel_reason TEXT`.
- **Remediation**:
  - Updated `apps/admin-web/src/components/PayoutDisputeResolutionModal.tsx` line 58 to pass `p_cancel_reason: cleanNotes`.
  - Updated MSW mock in `PayoutDisputeResolutionModal.test.tsx`.
- **Verification**: Tested against Vitest modal suite (7/7 passed) and verified parameter name reflection in `tests/stage6_manual_settlement_test.cjs` TEST 15.

---

### VER-MS-003: Unconstrained KPI Accumulator Inflating `payoutsPending` on Cancelled
- **Severity**: **MEDIUM**
- **Impact**: Cancelled settlements were counted as pending liabilities, artificially depressing the displayed available community balance and confusing administrators.
- **Root Cause**: In `apps/admin-web/src/pages/FinancialsPage.tsx`, the KPI calculator used an unconstrained `else` fallback that swept `status = 'cancelled'` into `payoutsPending`.
- **Remediation**:
  - Replaced fallback with `else if (tx.status === "pending_confirmation") { payoutsPending += tx.money_out || 0 }`.
- **Verification**: Verified in `apps/admin-web/src/pages/FinancialsPage.test.tsx` (6/6 passed) ensuring cancelled settlements do not inflate pending liabilities.

