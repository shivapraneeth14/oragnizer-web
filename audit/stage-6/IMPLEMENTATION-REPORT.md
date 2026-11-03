# Technical Implementation Report: Cluvo Stage 6 Remediation & Completion

This report details the architectural design, database migrations, Edge Functions, frontend applications, and mobile client implementations delivered for Cluvo Stage 6.

---

## 1. Scope & Core Architectural Principles

Cluvo Stage 6 enforces rigorous financial accuracy, concurrency safety, and auditable accounting across the Cluvo platform.

### Core Business Model Constraints
1. **Manual Settlement Architecture**:
   - Cluvo **does not** initiate or execute bank transfers, UPI transfers, or Razorpay payouts to organizers.
   - Platform administrators execute bank transfers externally outside Cluvo.
   - Administrators record settlement records in Cluvo with external UTR / reference metadata.
   - Organizers view recorded settlements and either **confirm receipt** or **file a dispute**.
   - Cluvo is solely responsible for ledger accounting, state transitions, reserved balance tracking, and immutable audit logs.
2. **Integer Paise Arithmetic**:
   - Every financial calculation, column, RPC parameter, and ledger balance strictly uses integer paise (`BIGINT` / `INTEGER`). Floating-point currency arithmetic is strictly prohibited.
3. **Deterministic Global Lock Hierarchy**:
   - In order to prevent 40P01 deadlocks during concurrent bookings, cancellations, check-ins, and settlements, all transactions acquire locks in strict descending scope order:
     - **Level 1**: Community row lock (`SELECT ... FROM communities WHERE id = ... FOR NO KEY UPDATE`)
     - **Level 2**: Event row lock (`SELECT ... FROM events WHERE id = ... FOR NO KEY UPDATE`)
     - **Level 3**: Registration row lock (`SELECT ... FROM registrations WHERE id = ... FOR UPDATE`)
     - **Level 4**: Payment row lock (`SELECT ... FROM payments WHERE id = ... FOR UPDATE`)
     - **Level 5**: Payout item row lock (`SELECT ... FROM payout_items WHERE id = ... FOR UPDATE`)

---

## 2. File Modification & Creation Inventory

### A. Repositories & Working Trees
- **Root Repository (`shivapraneeth14/oragnizer-web`)**:
  - Branch: `dev`
  - Contains: `supabase/`, `apps/admin-web/`, `apps/organizer-web/`, `tests/`
- **Mobile Sub-Repository (`shivapraneeth14/cluvo` at `apps/mobile`)**:
  - Branch: `dev`
  - Contains: Flutter client source and widget/navigation tests.

### B. Database Migrations (`supabase/migrations/`)
1. **`202611010014_atomic_cancel_and_claim_refund.sql`**:
   - Creates `public.cancel_registration_and_claim_refund(p_registration_id, p_caller_user_id, p_reason)`.
   - Atomically coordinates registration cancellation, QR invalidation, capacity decrement, and payment claim.
   - Guards against attended attendee cancellation (`checked_in = true`).
   - Hardens `public.claim_payment_refund` and `public.cancel_registration_and_decrement` with attended checks and strict Level 2 $\to$ Level 3 lock ordering.
2. **`202611010015_verified_admin_refund_resolution.sql`**:
   - Creates `public.admin_adopt_provider_refund(p_payment_id, p_refund_id, p_notes)` and `public.admin_manual_settlement(p_payment_id, p_settlement_method, p_reference_number, p_notes)`.
   - Enforces attended attendee guard (`not_refundable_attended`).
   - Implements structured validation ($\text{reference} \ge 10$ chars, $\text{notes} \ge 20$ chars).
   - Enforces unique constraint on offline settlement references across payments via partial unique index.
   - Records append-only entries in `public.payment_audit_log` and `public.payment_refund_history`.
3. **`202611010016_cryptographic_ticket_token.sql`**:
   - Updates `public.confirm_payment` to generate ticket validation tokens using `gen_random_bytes(32)` providing 256 bits of CSPRNG entropy, prefixed with `cluvo_` and hashed with SHA-256.
   - Enforces `COALESCE(qr_code, ...)` non-rotation guard on duplicate webhook deliveries.
4. **`202611010017_concurrency_safe_manual_settlements.sql`**:
   - Implements complete concurrency-safe manual settlement subsystem:
     - `public.admin_record_manual_payout`: Validates wallet and event-level payable limits, locks community and event rows, checks active UTR uniqueness, and reserves balance.
     - `public.organizer_confirm_manual_payout`: Concurrency-safe organizer confirmation. Locks community row first, verifies `status = 'pending_confirmation'`, debits `communities.wallet_balance`, and transitions status to `'success'`.
     - `public.organizer_dispute_manual_payout`: Concurrency-safe dispute filing. Locks community row first, verifies `status = 'pending_confirmation'`, and transitions status to `'disputed'`.
     - `public.admin_resolve_payout_dispute`: Handles dispute resolution (`confirm_received_payout` debits wallet; `cancel_disputed_payout` releases reservation).
     - `public.admin_cancel_manual_payout`: Cancels pending unconfirmed payout and releases reserved balance.
     - `public.get_admin_financial_statement` and `public.get_organizer_financial_statement`: High-fidelity passbook ledgers mapping debits, credits, and payout states with `NULL::TEXT AS attendee_phone` compatibility.

### C. Supabase Edge Functions (`supabase/functions/`)
1. **`supabase/functions/admin-adopt-refund/index.ts`**:
   - Authenticated Edge Function requiring platform administrator role.
   - Queries Razorpay Payments API (`https://api.razorpay.com/v1/payments/:pay_id/refunds/:rfnd_id`).
   - Verifies refund belongs to targeted payment, currency is `INR`, refund amount matches exactly, and status is `processed`.
   - Dispatches `public.admin_adopt_provider_refund` only on verified provider response.
2. **`supabase/functions/issue-refund/index.ts`**:
   - Hardened to execute `public.cancel_registration_and_claim_refund` atomically before invoking Razorpay API.
   - Preserves integer paise arithmetic and records structured error states.
3. **`supabase/functions/_shared/refunds.ts`**:
   - Shared validation utilities for refund amount bounds, currency integrity, and Razorpay error mapping.

### D. Admin Web Application (`apps/admin-web/`)
1. **`src/components/RefundManualReviewModal.tsx`**:
   - Admin UI for manual refund review, external provider adoption, and offline cash/bank settlement.
   - Enforces reference length $\ge 10$ and audit notes $\ge 20$ characters.
   - Routes provider refund adoption through `admin-adopt-refund` Edge Function.
2. **`src/components/PayoutDisputeResolutionModal.tsx`**:
   - Modal for resolving organizer disputes and cancelling pending unconfirmed settlements.
   - Corrected to pass `p_cancel_reason: cleanNotes` matching PostgreSQL signature.
3. **`src/components/TransactionDetailDrawer.tsx`**:
   - Comprehensive passbook transaction inspector rendering attendee metadata, payment claim states, settlement UTRs, and dispute resolution history.
4. **`src/pages/FinancialsPage.tsx`**:
   - Executive financial dashboard and 3-way reconciliation engine.
   - Fixed KPI accumulator to increment `payoutsPending` only when `tx.status === "pending_confirmation"`, preventing cancelled payouts from distorting locked balances.

### E. Organizer Web Application (`apps/organizer-web/`)
1. **`src/components/payout/payout-section.tsx`**:
   - Organizer financial overview and settlement confirmation interface.
   - Renders recorded manual payouts with external UTR references and notes.
   - Provides action buttons to **Confirm Receipt** or **Dispute Settlement**.
   - Handles concurrency conflicts gracefully (e.g., if payout was already resolved or cancelled).

### F. Mobile Flutter Client (`apps/mobile/` - `shivapraneeth14/cluvo`)
1. **`lib/app.dart`**:
   - Registered dedicated GoRouter routes: `/payments/:id` and `/refunds/:id`.
2. **`lib/screens/my_payments_screen.dart`**:
   - Categorizes payments into active registrations and historical refund receipts.
   - Deep-links directly to `/refunds/:id` for claimed and processed refunds.
3. **`lib/screens/payment_detail_screen.dart`**:
   - Displays payment and refund receipts with transaction timestamps, claim reasons, and Razorpay reference identifiers.

---

## 3. Concurrency Protection & Invariant Verification Summary

| Invariant | Implementation Mechanism | Enforced At |
| :--- | :--- | :--- |
| **No Double Debit** | `SELECT ... FROM communities WHERE id = ... FOR UPDATE` before checking `status = 'pending_confirmation'` | PostgreSQL RPC |
| **Atomic Cancellation & Claim** | `cancel_registration_and_claim_refund` single transaction with `events` $\to$ `registrations` $\to$ `payments` locks | PostgreSQL RPC |
| **Attended Protection** | `IF v_reg.checked_in THEN RAISE EXCEPTION 'not_refundable_attended'` | All 5 Refund & Cancel RPCs |
| **Integer Paise Arithmetic** | All amounts stored and computed as `BIGINT` / `INTEGER` paise | Database Schema & Code |
| **Active UTR Uniqueness** | Scoped unique check on `(community_id, event_id, utr)` for active statuses | PostgreSQL RPC & Index |
| **Event Balance Ceiling** | Uncommitted event balance calculation inside `admin_record_manual_payout` | PostgreSQL RPC |
| **Provider Status Verification** | Razorpay HTTP API query verifying `status = 'processed'` before database update | Edge Function |
| **Append-Only Audit Log** | Every financial mutation writes to `payment_audit_log` with before/after state | PostgreSQL Triggers / RPCs |

