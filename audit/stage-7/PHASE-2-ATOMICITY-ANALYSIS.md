# CLUVO STAGE 7 PHASE 2: CUSTOMER CANCELLATION & REFUND ATOMICITY ANALYSIS (SEC-01)

**Classification:** CONFIRMED DEFECT  
**Severity:** HIGH / CRITICAL FINANCIAL RELIABILITY  
**Component:** `supabase/functions/cancel-registration/index.ts` & `supabase/migrations/202611010014_atomic_cancel_and_claim_refund.sql`  
**Date:** 2026-11-01  
**Author:** Principal Security Engineer & PostgreSQL Architect  

---

## 1. Executive Summary

In Stage 6, Cluvo established strict financial atomicity invariants and created the PostgreSQL function `cancel_registration_and_claim_refund` (Migration `202611010014_atomic_cancel_and_claim_refund.sql`) to bind ticket cancellation, capacity release, and refund claim acquisition into a single atomic database transaction.

However, an independent inspection of the customer self-cancellation edge function (`supabase/functions/cancel-registration/index.ts`) reveals that **customer self-cancellation does NOT utilize `cancel_registration_and_claim_refund`**. Instead, it executes a two-transaction sequence:
1. **Transaction 1 (PostgreSQL):** Calls `cancel_registration_and_decrement`, committing the cancellation of the registration and releasing capacity.
2. **Transaction 2 (TypeScript runtime):** Calls `attemptRefund` in `_shared/refunds.ts`, which attempts to acquire `claim_payment_refund` and invoke Razorpay.

If the Edge Function crashes, times out, exceeds memory limits, or experiences a network disruption between lines 131 and 141 of `cancel-registration/index.ts`, **Transaction 1 has already committed, but no refund claim or recovery marker exists in the database**. Furthermore, `supabase/functions/reconcile-payments/index.ts` will **never detect or recover this payment**, leaving the customer's funds permanently stranded.

Additionally, our inspection confirmed that `cancel_registration_and_claim_refund` in its current form **cannot simply be called by `cancel-registration`** due to three blocking defects:
1. It rejects customer callers (only authorizes community owner, organizer, moderator, or admin).
2. It hardcodes `refund_reason = 'organizer_issue_refund'`.
3. It hardcodes `refund_amount_due = v_payment.amount`, violating the customer self-cancellation policy where the platform fee is retained.

---

## 2. Detailed Technical Breakdown & Crash Window

### 2.1 The Two-Phase Execution Flow in `cancel-registration/index.ts`

Lines 119–143 of `supabase/functions/cancel-registration/index.ts`:

```typescript
// ORDER MATTERS: cancel the registration FIRST (one transaction — the RPC
// only decrements booked_count when the registration actually transitioned
// confirmed -> cancelled, so concurrent cancels can never double-release),
// THEN issue the refund. The old order (refund first) left a window where
// the payment could be refunded while the registration was still
// confirmed — a concurrent payment capture in that window ended up paid
// with no recoverable booking. If the refund fails here, the claim is
// released as 'failed' and the reconcile retry job re-issues it later
// using the persisted refund_amount_due (never re-deriving the policy).
await supabase.rpc("cancel_registration_and_decrement", {
  p_registration_id: registration.id,
  p_deleted_at: new Date().toISOString(),
})

if (payment && payment.status === "success" && payment.razorpay_payment_id) {
  try {
    // POLICY: customer self-cancellation refunds the ticket only — the
    // platform fee (flat fee + GST, persisted at order creation) is
    // NOT refundable on a self-cancel; it stays with the platform.
    const fee = Math.max(Number(payment.platform_fee ?? 0), 0)
    const refundAmount = Math.max(Number(payment.amount) - fee, 0)

    const outcome = await attemptRefund(supabase, payment, refundAmount, "registration_cancellation")
```

### 2.2 The Vulnerability Window (Lines 131–141)

When `supabase.rpc("cancel_registration_and_decrement")` completes:
- The database transaction commits immediately.
- `registrations.status` is updated to `'cancelled'`.
- `events.booked_count` is decremented by 1.
- However, table `payments` remains completely unmodified:
  - `payments.refund_claim_state = NULL`
  - `payments.refund_status = NULL`
  - `payments.refund_reason = NULL`
  - `payments.refund_amount_due = NULL`
  - `payments.status = 'success'`

If a crash occurs immediately after line 131 (e.g., Deno runtime OOM, container restart, process termination, HTTP timeout, or unhandled exception during parameter preparation):
- The ticket is cancelled.
- The capacity is released to another attendee.
- **No refund was initiated with Razorpay.**
- **No claim was registered in PostgreSQL.**

### 2.3 The Reconciliation Gap in `reconcile-payments/index.ts`

Lines 203–216 of `supabase/functions/reconcile-payments/index.ts`:

```typescript
const { data: dueRefunds, error: dueErr } = await supabase
  .from("payments")
  .select("id, refund_status, refund_attempt_count, razorpay_refund_id, amount, refunded_amount, refund_amount_due, refund_reason, updated_at, status")
  .in("status", ["refunded", "failed", "success"])
  .or("refund_status.in.(requested,pending,failed,queued),and(refund_status.is.null,refund_reason.not.is.null)")
  .lt("refund_attempt_count", REFUND_ATTEMPT_CAP)
  .lt("updated_at", new Date(Date.now() - 15 * 60 * 1000).toISOString())
```

Notice the SQL filter condition:
```sql
refund_status IN ('requested', 'pending', 'failed', 'queued')
OR (refund_status IS NULL AND refund_reason IS NOT NULL)
```

In the crash window scenario:
1. `refund_status` is `NULL`.
2. `refund_reason` is `NULL` (because `attemptRefund` was never invoked and `claim_payment_refund` was never called).
3. Therefore, `and(refund_status.is.null, refund_reason.not.is.null)` evaluates to **`FALSE`**.
4. The stranded payment is **excluded from `dueRefunds`**.
5. The scheduled background reconciliation cron will **never see the row**, leaving the customer charged and without their ticket.

---

## 3. Analysis of Existing `cancel_registration_and_claim_refund`

Migration `202611010014_atomic_cancel_and_claim_refund.sql` created an atomic procedure, but it was tailored exclusively for organizer/admin initiated refunds (`admin-issue-refund` or organizer console).

### 3.1 Defect 1: Unauthorized Customer Callers
Lines 44–55 of Migration 14:
```sql
IF NOT (
  EXISTS (SELECT 1 FROM public.communities c WHERE c.id = v_community_id AND c.owner_id = p_caller_id)
  OR EXISTS (
    SELECT 1 FROM public.community_members m
    WHERE m.community_id = v_community_id
      AND m.user_id = p_caller_id
      AND m.role IN ('ORGANIZER', 'MODERATOR')
  )
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_caller_id AND p.is_admin = TRUE)
) THEN
  RETURN jsonb_build_object('error', 'Unauthorized: Insufficient permissions to refund this payment');
END IF;
```
If called with `p_caller_id = registration.user_id` (the ticket buyer), this check returns an authorization error because it fails to verify `r.user_id = p_caller_id`.

### 3.2 Defect 2: Hardcoded Reason
Lines 112–119 of Migration 14:
```sql
UPDATE public.payments
SET refund_claim_state = 'claimed',
    refund_claim_at = clock_timestamp(),
    refund_attempt_count = COALESCE(refund_attempt_count, 0) + 1,
    refund_reason = 'organizer_issue_refund',
    refund_amount_due = v_payment.amount,
    updated_at = clock_timestamp()
WHERE id = p_payment_id;
```
The reason is hardcoded to `'organizer_issue_refund'`. In customer cancellation, this misrepresents the audit trail and financial reporting.

### 3.3 Defect 3: Platform Fee Retention Violation
Line 117 sets `refund_amount_due = v_payment.amount`.
Cluvo's business policy is:
- **Organizer/Admin Cancellation or Event Cancellation:** 100% full refund (`v_payment.amount`).
- **Customer Self-Cancellation:** Ticket price refunded, **platform fee retained** (`v_payment.amount - v_payment.platform_fee`).
If `cancel_registration_and_claim_refund` were used as-is, either the customer would receive a 100% refund, or if Razorpay failed, `reconcile-payments` would subsequently pay out the full amount, losing platform revenue.

### 3.4 Defect 4: Free Ticket Handling
Step 0 looks up the payment:
```sql
SELECT p.registration_id, r.event_id, e.community_id
INTO v_reg_id, v_event_id, v_community_id
FROM public.payments p ...
WHERE p.id = p_payment_id;
```
Free tickets do not possess a payment row (`payments` record is absent or null). Passing `p_payment_id` is impossible for free tickets.

---

## 4. Comprehensive 12-Scenario Atomicity & Concurrency Matrix

The following matrix analyzes all cancellation and refund edge cases across the platform lifecycle:

| # | Scenario | Concurrent Actors / Events | Current Behavior & Defect | Proposed Atomic Behavior | Invariants Preserved |
|---|---|---|---|---|---|
| **1** | Free Ticket Self-Cancellation | Customer cancels RSVP | Calls `cancel_registration_and_decrement`. No payment exists. Succeeded cleanly. | Calls atomic RPC with `p_payment_id = NULL`. Decrements capacity once, marks cancelled. | Capacity $\ge 0$, idempotent. |
| **2** | Paid Ticket — Instant Razorpay Success | Customer cancels via mobile app | Cancels via RPC, then TypeScript calls Razorpay and succeeds. Status updated to `refunded`. | Atomic RPC cancels ticket, decrements capacity, and claims refund debt. Razorpay succeeds, marks `issued`. | No crash window, exactly-once capacity. |
| **3** | Paid Ticket — Razorpay Network Timeout | Customer cancels, Razorpay hangs $>15\text{s}$ | `attemptRefund` throws timeout. Claim marked `failed`. Reconcile job picks it up later. Works, BUT if crash occurs before `claim`, row is lost. | Atomic RPC guarantees claim is persisted *before* Razorpay is contacted. Timeout safely delegates to reconcile job. | Zero lost refund debt. Reconcile recovers without re-deriving policy. |
| **4** | Paid Ticket — Crash Between DB Commit & Razorpay | Worker killed / OOM between lines 131 and 141 | **CRITICAL DEFECT:** Ticket cancelled, capacity decremented, `payments` row unmodified. `reconcile-payments` ignores it. Customer loses money. | Atomic RPC claims refund debt in same transaction as cancellation. Reconcile picks up `refund_claim_state = 'claimed'` or `refund_reason IS NOT NULL`. | Zero orphan cancellations. Customer refund guaranteed. |
| **5** | Paid Ticket with Applied Coupon | Customer cancels order where coupon was used | Registration cancelled, ticket refunded. `used_count` on coupon was already incremented at booking. | Registration cancelled, ticket refunded (net amount paid). Coupon usage remains tracked according to coupon policy. | Financial ledger remains balanced in integer paise. |
| **6** | Event with Waitlist Auto-Promotion | Customer cancels, waitlist queue active | `cancel_registration_and_decrement` frees capacity; trigger or worker promotes next waitlist user. | Capacity release and claim occur atomically. Promoted user claims slot without race. | Event `booked_count \le max_capacity`. |
| **7** | Concurrent Double-Cancellation Requests | Customer taps cancel twice rapidly on slow network | `cancel_registration_and_decrement` checks `status = 'confirmed'`. 2nd call returns 0 rows updated, skips refund. | Row-level `FOR UPDATE` on registration serializes requests. Second call receives `'already_cancelled'`. | Exactly-once capacity decrement; zero duplicate refunds. |
| **8** | Customer Cancel vs Admin Bulk Event Cancel | Customer cancels while admin cancels entire event | Potential race on event row and payment row locks. | Both operations follow Global Lock Hierarchy: Event (L1) $\to$ Registration (L2) $\to$ Payment (L3). Zero deadlock (no `40P01`). | Deadlock-free serialization. |
| **9** | Customer Cancel vs Organizer Issue Refund | Customer cancels while organizer refunds from web | Organizer calls `cancel_registration_and_claim_refund`. Customer calls `cancel-registration`. | Both acquire Event $\to$ Registration $\to$ Payment lock. First to acquire cancels and claims; second receives `already_cancelled` or `conflict`. | Exactly-one refund claim granted; zero double-refund. |
| **10** | Customer Cancel on Attended Ticket | Ticket scanned at door (`status = 'attended'`) | `cancel-registration` currently only checks `status === 'confirmed'`. | Atomic RPC explicitly checks `v_reg_status = 'attended'` and rejects with `'not_refundable_attended'`. | Attended tickets cannot be refunded under any circumstances. |
| **11** | Reconcile-Payments Recovery | Unsettled claim after 15 min recooldown | Currently ignores crash-window payments (`refund_status IS NULL AND refund_reason IS NULL`). | Reconcile queries all claimed or due refunds with persisted `refund_amount_due`. Executes provider sync or reissue. | Idempotent reconciliation without double-issuance. |
| **12** | Admin Manual Adoption | Admin matches orphaned Razorpay refund via dashboard | Admin inputs Razorpay refund ID into `admin_adopt_provider_refund`. | Validates payment ID, currency (INR), amount match, and transitions claim to `issued`. | Audit trail preserved; wallet ledger synced. |

---

## 5. Architectural Remediation Design

To resolve SEC-01 safely without disrupting existing Stage 6 functionality, we propose enhancing `cancel_registration_and_claim_refund` to accept optional policy parameters and support both attendee and organizer callers.

### 5.1 Proposed RPC Signature & Implementation

```sql
CREATE OR REPLACE FUNCTION public.cancel_registration_and_claim_refund(
  p_registration_id UUID,
  p_caller_id UUID,
  p_refund_reason TEXT DEFAULT 'organizer_issue_refund',
  p_custom_refund_amount INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reg RECORD;
  v_event RECORD;
  v_payment RECORD;
  v_booked_decremented BOOLEAN := FALSE;
  v_refund_amount INTEGER;
BEGIN
  -- 1. Global Lock Hierarchy Level 1: Find Event ID and Lock Event Row FIRST
  SELECT r.id, r.event_id, r.user_id, r.status, e.community_id
  INTO v_reg
  FROM public.registrations r
  JOIN public.events e ON e.id = r.event_id
  WHERE r.id = p_registration_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Registration not found');
  END IF;

  -- 2. Authorization: Caller must be Attendee, Community Owner, Organizer/Moderator, or Platform Admin
  IF NOT (
    v_reg.user_id = p_caller_id
    OR EXISTS (SELECT 1 FROM public.communities c WHERE c.id = v_reg.community_id AND c.owner_id = p_caller_id)
    OR EXISTS (
      SELECT 1 FROM public.community_members m
      WHERE m.community_id = v_reg.community_id
        AND m.user_id = p_caller_id
        AND m.role IN ('ORGANIZER', 'MODERATOR')
    )
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_caller_id AND p.is_admin = TRUE)
  ) THEN
    RETURN jsonb_build_object('error', 'Unauthorized: Insufficient permissions to cancel registration');
  END IF;

  -- Lock Event Row (Level 1)
  PERFORM 1 FROM public.events WHERE id = v_reg.event_id FOR UPDATE;

  -- 3. Global Lock Hierarchy Level 2: Lock Registration Row SECOND
  SELECT status INTO v_reg.status
  FROM public.registrations
  WHERE id = p_registration_id
  FOR UPDATE;

  IF v_reg.status = 'attended' THEN
    RETURN jsonb_build_object('error', 'not_refundable_attended', 'message', 'Attendee already attended');
  END IF;

  IF v_reg.status = 'cancelled' THEN
    RETURN jsonb_build_object('error', 'already_cancelled', 'message', 'Registration is already cancelled');
  END IF;

  -- 4. Global Lock Hierarchy Level 3: Lock Payment Row THIRD (if payment exists)
  SELECT * INTO v_payment
  FROM public.payments
  WHERE registration_id = p_registration_id
  FOR UPDATE;

  -- 5. Atomic Cancellation: cancel ticket and clear QR code
  UPDATE public.registrations
  SET status = 'cancelled',
      qr_code = NULL,
      deleted_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = p_registration_id;

  -- Exactly-once capacity decrement
  IF v_reg.status = 'confirmed' THEN
    UPDATE public.events
    SET booked_count = GREATEST(0, booked_count - 1),
        updated_at = clock_timestamp()
    WHERE id = v_reg.event_id;
    v_booked_decremented := TRUE;
  END IF;

  -- If free registration (no payment), complete immediately
  IF v_payment.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'registration_id', p_registration_id,
      'is_paid', false,
      'decremented_capacity', v_booked_decremented
    );
  END IF;

  -- Calculate refund amount based on caller policy:
  -- If custom refund amount supplied (e.g. ticket price minus platform fee), use it;
  -- otherwise default to payment amount.
  IF p_custom_refund_amount IS NOT NULL THEN
    v_refund_amount := LEAST(v_payment.amount, GREATEST(0, p_custom_refund_amount));
  ELSE
    v_refund_amount := v_payment.amount;
  END IF;

  -- 6. Acquire refund claim & persist durable recovery debt in same transaction
  UPDATE public.payments
  SET refund_claim_state = 'claimed',
      refund_claim_at = clock_timestamp(),
      refund_attempt_count = COALESCE(refund_attempt_count, 0) + 1,
      refund_reason = p_refund_reason,
      refund_amount_due = v_refund_amount,
      updated_at = clock_timestamp()
  WHERE id = v_payment.id;

  RETURN jsonb_build_object(
    'ok', true,
    'payment_id', v_payment.id,
    'registration_id', p_registration_id,
    'amount_due', v_refund_amount,
    'razorpay_payment_id', v_payment.razorpay_payment_id,
    'claim_attempt', COALESCE(v_payment.refund_attempt_count, 0) + 1,
    'decremented_capacity', v_booked_decremented,
    'is_paid', true
  );
END;
$$;
```

### 5.2 Refactoring `cancel-registration/index.ts`

With the atomic RPC in place, `cancel-registration/index.ts` is simplified and crash-proof:
1. Calculates `refundAmount = Math.max(payment.amount - fee, 0)`.
2. Calls `cancel_registration_and_claim_refund({ p_registration_id, p_caller_id: user.id, p_refund_reason: 'registration_cancellation', p_custom_refund_amount: refundAmount })`.
3. If paid, passes the returned claim directly to `attemptRefund(..., existingClaim)`.
4. If the Edge Function crashes at any moment after step 2, `payments` already holds `refund_claim_state = 'claimed'`, `refund_reason = 'registration_cancellation'`, and `refund_amount_due = refundAmount`.
5. When `reconcile-payments` runs 15 minutes later, it automatically detects the row and finishes processing the refund.

---

## 6. Verification and Regression Analysis

1. **Lock Hierarchy Invariant:** Level 1 (`events`) $\to$ Level 2 (`registrations`) $\to$ Level 3 (`payments`). Deadlock hazard with concurrent bookings (`reserve_ticket_capacity`) or organizer cancellations is mathematically eliminated.
2. **Attended Invariant:** Scanned tickets (`status = 'attended'`) are permanently non-refundable.
3. **Paise Accuracy Invariant:** All amounts are integer paise. Platform fee is preserved for customer self-cancellation.
4. **Reconcile Invariant:** Reconcile cron picks up all interrupted cancellations without re-evaluating fee policies.

