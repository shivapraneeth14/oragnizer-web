# CLUVO STAGE 7 PHASE 2: SECURITY & RELIABILITY TEST PLAN

**Scope:** SEC-01 (Atomicity), SEC-02 (Coupon RPC Permissions), SEC-03 (Media Upload Security)  
**Date:** 2026-11-01  
**Author:** Senior QA Engineer & Database Architect  

---

## 1. Testing Framework & Safety Rules

All verification and test executions must strictly abide by Cluvo's safety standards:
1. **Isolated Test Database Only:** All database tests run exclusively against the local isolated database (`cluvo_test_stage6`).
2. **No Production or Staging Access:** Zero environment tokens or remote connection strings used.
3. **No External Financial Calls:** Razorpay APIs must be mocked. Zero real bank transfers, payments, or refunds.
4. **Clean Fixture Isolation:** Every test suite provisions synthetic test rows with unique UUIDs and uses `try/finally` blocks to guarantee complete teardown and client disconnection.

---

## 2. Test Suite 1: Customer Cancellation Atomicity (SEC-01)

### 2.1 Test 1.1 — Unified Atomic RPC Functionality
**Objective:** Verify that the updated `cancel_registration_and_claim_refund` handles both free and paid tickets, authorizes attendee callers, and retains the platform fee on customer cancellation.
- **Fixture:**
  - Create synthetic community, event (`max_capacity = 10`, `booked_count = 1`), user profile, and registration (`status = 'confirmed'`).
  - For paid test: Create payment (`amount = 10000` paise = ₹100, `platform_fee = 1000` paise = ₹10, `status = 'success'`, `razorpay_payment_id = 'pay_synth_1'`).
- **Steps:**
  1. Call `cancel_registration_and_claim_refund` as the attendee user (`p_caller_id = user.id`, `p_custom_refund_amount = 9000`, `p_refund_reason = 'registration_cancellation'`).
- **Expected Results:**
  - Registration `status` transitions to `'cancelled'`, `qr_code` becomes `NULL`.
  - Event `booked_count` decrements to `0`.
  - Payment row updates atomically:
    - `refund_claim_state = 'claimed'`
    - `refund_amount_due = 9000` (Platform fee ₹10 retained)
    - `refund_reason = 'registration_cancellation'`
    - `refund_attempt_count = 1`
  - All changes occur within a single atomic commit.

### 2.2 Test 1.2 — Crash Window Simulation & Orphan Prevention
**Objective:** Prove that if the Edge Function execution halts immediately after the atomic RPC, no orphan cancellation occurs.
- **Steps:**
  1. Execute the atomic RPC.
  2. Terminate the test process (simulating an Edge Function crash before calling Razorpay).
  3. Inspect table `payments` in a new connection.
- **Expected Results:**
  - `payments.refund_claim_state` is `'claimed'`.
  - `payments.refund_amount_due` is `9000`.
  - `payments.refund_reason` is `'registration_cancellation'`.
  - The payment is permanently marked for recovery.

### 2.3 Test 1.3 — Reconcile-Payments Background Recovery
**Objective:** Verify that `supabase/functions/reconcile-payments/index.ts` automatically discovers and recovers the crashed payment.
- **Steps:**
  1. Seed a payment in the crashed state (`refund_claim_state = 'claimed'`, `refund_amount_due = 9000`, `updated_at = NOW() - INTERVAL '16 minutes'`).
  2. Invoke `reconcile-payments` handler with mocked Razorpay responses.
- **Expected Results:**
  - The reconcile query `.or("refund_status.in.(requested,pending,failed,queued),and(refund_status.is.null,refund_reason.not.is.null)")` successfully matches the row.
  - Reconcile engine dispatches Razorpay refund for ₹90.
  - Payment transitions to `status = 'refunded'`, `refund_status = 'processed'`, `refunded_amount = 9000`.

### 2.4 Test 1.4 — Concurrency & Global Lock Ordering Verification
**Objective:** Verify that concurrent operations between ticket booking (`reserve_ticket_capacity`) and cancellation (`cancel_registration_and_claim_refund`) follow the exact global lock hierarchy without deadlocks.
- **Steps:**
  1. Connection A begins a transaction and locks the event row (`FOR UPDATE`).
  2. Connection B starts `cancel_registration_and_claim_refund` on a registration under the same event.
  3. Verify Connection B enters lock wait state on `events` (`pg_stat_activity.wait_event_type = 'Lock'`).
  4. Connection A completes and commits.
  5. Connection B resumes and executes cleanly.
  6. Repeat in reverse order.
- **Expected Results:**
  - Zero PostgreSQL `40P01` deadlock errors.
  - Final `booked_count` accurately reflects net balance.

### 2.5 Test 1.5 — Attended Ticket Refund Guard
**Objective:** Verify that tickets with `status = 'attended'` can never be cancelled or refunded.
- **Steps:**
  1. Create synthetic registration with `status = 'attended'`.
  2. Call `cancel_registration_and_claim_refund`.
- **Expected Results:**
  - Rejection with error `'not_refundable_attended'`.
  - Ticket remains `'attended'`.
  - Payment row remains untouched.

---

## 3. Test Suite 2: Coupon RPC Access Control (SEC-02)

### 3.1 Test 2.1 — Anonymous PostgREST Caller Rejection
**Objective:** Verify that an unauthenticated caller cannot invoke `claim_coupon` or `release_coupon`.
- **Steps:**
  1. Connect to PostgreSQL using role `anon` (or HTTP `POST /rest/v1/rpc/claim_coupon` with anon key).
- **Expected Results:**
  - PostgreSQL error: `42501: permission denied for function claim_coupon`.
  - HTTP response: `403 Forbidden`.

### 3.2 Test 2.2 — Authenticated Customer Caller Rejection
**Objective:** Verify that an authenticated standard user cannot invoke `claim_coupon` or `release_coupon`.
- **Steps:**
  1. Connect using role `authenticated` (with user JWT).
  2. Attempt to call `claim_coupon(p_coupon_id)`.
- **Expected Results:**
  - PostgreSQL error: `42501: permission denied for function claim_coupon`.
  - Coupon `used_count` remains unchanged.

### 3.3 Test 2.3 — Service Role Authorization
**Objective:** Verify that Supabase Edge Functions connecting via `service_role` execute `claim_coupon` and `release_coupon` successfully.
- **Steps:**
  1. Connect using role `service_role`.
  2. Execute `claim_coupon` and `release_coupon`.
- **Expected Results:**
  - Both RPCs execute successfully with expected JSON responses (`{"claimed": true}` and `{"released": true}`).

### 3.4 Test 2.4 — Atomic Concurrency under Max Uses
**Objective:** Verify that two concurrent `service_role` claims on a coupon with 1 remaining use allow exactly one claim to succeed.
- **Steps:**
  1. Seed coupon with `max_uses = 5`, `used_count = 4`.
  2. Launch two concurrent transactions invoking `claim_coupon`.
- **Expected Results:**
  - Exactly one call returns `{"claimed": true}`.
  - Exactly one call returns `{"claimed": false, "reason": "exhausted"}`.
  - Final `used_count` is 5.

---

## 4. Test Suite 3: Media Upload & Deletion Security (SEC-03)

### 4.1 Test 3.1 — Client-Side Magic-Byte Validation (Mobile & Web)
**Objective:** Verify that files with mismatched extensions or invalid magic numbers are rejected before any network transfer.
- **Test Cases:**
  1. Text file renamed to `avatar.png` (Header: `48 65 6C 6C 6F`) $\to$ Rejected (`Invalid image file header`).
  2. Valid PNG header (`89 50 4E 47 0D 0A 1A 0A`) with size 500KB $\to$ Passes validation.
  3. Valid JPEG header (`FF D8 FF`) with size 11MB $\to$ Rejected (`File is too large. Maximum size is 10 MB`).
  4. Executable binary payload renamed to `video.mp4` $\to$ Rejected (`Invalid video file header`).
  5. Valid MP4 with `ftyp` at offset 4 $\to$ Passes validation.

### 4.2 Test 3.2 — Delete Media Edge Function Anti-Destruction Guards
**Objective:** Verify that active profile avatars, community banners, and event media cannot be destroyed via `delete-media`.
- **Test Cases:**
  1. User A calls `delete-media` on a `public_id` that matches User B's active `avatar_url` $\to$ Rejection with `403 Cannot destroy active profile avatar`.
  2. User calls `delete-media` on an active community banner $\to$ Rejection with `403 Cannot destroy active community asset`.
  3. Unauthenticated request without JWT $\to$ Rejection with `401 Unauthorized`.
  4. Legitimate media owner deletes an orphaned asset $\to$ Cloudinary HMAC signature generated server-side, deletion succeeds.

---

## 5. Stage 6 Regression Invariant Checklist

Before any implementation is considered complete, the following core Stage 6 invariants must pass verification:

1. **Lock Ordering Hierarchy:** Event (L1) $\to$ Registration (L2) $\to$ Payment (L3) $\to$ Organizer Wallet (L4).
2. **Financial Ledger Balancing:** Total debits = total credits in integer paise across all wallet and settlement operations.
3. **Attended Protection:** Attended tickets can never be refunded.
4. **Manual Settlement Non-Duplication:** Organizer confirmation cannot double-debit; dispute and confirmation cannot race.
5. **No Overselling:** `booked_count \le max_capacity` guaranteed under heavy concurrent bookings and cancellations.

