# CLUVO STAGE 7 PHASE 2: SECURITY & RELIABILITY DEEP AUDIT REPORT

**Date:** 2026-11-01  
**Mode:** PLAN MODE — READ-ONLY INDEPENDENT AUDIT  
**Scope:** SEC-01 (Atomicity), SEC-02 (Coupon RPCs), SEC-03 (Cloudinary Media)  
**Repositories:**  
- `shivapraneeth14/oragnizer-web` (Dev Branch)  
- `shivapraneeth14/cluvo` (Dev Branch)  
**Authors:** Principal Security Engineer, PostgreSQL Architect & Senior QA Lead  

---

## 1. Executive Summary & Findings Overview

Following the comprehensive Stage 7 Product Discovery, an independent, read-only security and reliability investigation was conducted on the three highest-priority findings:
1. **SEC-01:** Customer Cancellation and Refund Atomicity
2. **SEC-02:** Public Execution Permissions on Coupon RPCs
3. **SEC-03:** Cloudinary Unsigned Upload Security and Media Management

Each finding was investigated through source-code inspection, architectural flow analysis, and local testing against the isolated database schema.

### 1.1 Findings Summary Table

| Finding ID | Title | Classification | Severity | Affected Components | Root Cause Summary |
|---|---|---|---|---|---|
| **SEC-01** | Customer Cancellation & Refund Crash Window | **CONFIRMED** | **HIGH** | `supabase/functions/cancel-registration/index.ts`<br>`202611010014_atomic_cancel_and_claim_refund.sql` | Registration cancellation commits in DB before refund claim is acquired in TypeScript runtime. Crash leaves orphaned cancelled ticket with zero refund marker; cron reconciler ignores row. Existing atomic RPC rejects customer callers and hardcodes full refund. |
| **SEC-02** | Unrestricted Public Execution on Coupon RPCs | **CONFIRMED** | **HIGH** | `supabase/migrations/202607300012_coupon_atomic_claim.sql` | `claim_coupon` and `release_coupon` functions have default PostgreSQL permissions (`PUBLIC`). Any anonymous or authenticated user can call them via PostgREST to exhaust coupon inventory. |
| **SEC-03** | Cloudinary Unsigned Preset Direct API Bypass | **CONFIRMED (MITIGATED RISK)** | **MEDIUM** | `apps/mobile/lib/services/cloudinary.dart`<br>`apps/organizer-web/src/lib/cloudinary.ts`<br>`supabase/functions/delete-media/index.ts` | Secret is safe and client performs magic-byte checks. However, unsigned preset allows direct external HTTP POST to Cloudinary bypassing client checks if Cloudinary console restrictions are permissive. |

---

## 2. Investigation 1 (SEC-01): Customer Cancellation & Refund Atomicity

### 2.1 The Crash Window in `cancel-registration/index.ts`
In `supabase/functions/cancel-registration/index.ts`, customer self-cancellation is split across two transactions:
```typescript
// Transaction 1: Commits immediately to Postgres
await supabase.rpc("cancel_registration_and_decrement", {
  p_registration_id: registration.id,
  p_deleted_at: new Date().toISOString(),
})

// Transaction 2: Executed in Node/Deno runtime
if (payment && payment.status === "success" && payment.razorpay_payment_id) {
  const fee = Math.max(Number(payment.platform_fee ?? 0), 0)
  const refundAmount = Math.max(Number(payment.amount) - fee, 0)
  const outcome = await attemptRefund(supabase, payment, refundAmount, "registration_cancellation")
}
```

If the execution terminates between lines 131 and 141:
- `registrations.status` is set to `'cancelled'`.
- `events.booked_count` is decremented.
- The `payments` table has **NO record of the cancellation or refund claim**:
  - `refund_claim_state = NULL`
  - `refund_status = NULL`
  - `refund_reason = NULL`
  - `refund_amount_due = NULL`
  - `status = 'success'`

### 2.2 The Background Reconciliation Gap
In `supabase/functions/reconcile-payments/index.ts` (line 211), the query selecting due refunds specifies:
```typescript
.or("refund_status.in.(requested,pending,failed,queued),and(refund_status.is.null,refund_reason.not.is.null)")
```
Because `refund_status` is `NULL` and `refund_reason` is `NULL`, this crashed row is **completely ignored by background reconciliation**. The customer is left without their ticket and without their money.

### 2.3 Compatibility Defects in Migration 14's `cancel_registration_and_claim_refund`
We investigated whether `cancel-registration` could directly call `cancel_registration_and_claim_refund` from Migration `202611010014_atomic_cancel_and_claim_refund.sql`. It cannot, due to three defects:
1. **Caller Authorization:** Lines 44–55 check if caller is owner, organizer, moderator, or admin. It rejects the ticket attendee (`user_id`).
2. **Hardcoded Reason:** Line 116 sets `refund_reason = 'organizer_issue_refund'`.
3. **Fee Retention Violation:** Line 117 sets `refund_amount_due = v_payment.amount`. Cluvo's policy on customer self-cancellations requires retaining the platform fee (`amount - platform_fee`). Refunding 100% loses platform revenue.
4. **Free Tickets:** Step 0 fails if no payment record exists.

### 2.4 Remediation Plan
1. Update `cancel_registration_and_claim_refund` to:
   - Accept `p_registration_id`, `p_caller_id`, `p_refund_reason`, and optional `p_custom_refund_amount`.
   - Authorize attendee callers (`r.user_id = p_caller_id`).
   - Retain platform fee according to caller policy.
   - Support free registrations gracefully.
2. Refactor `cancel-registration/index.ts` to call the updated RPC in a single atomic database step before invoking Razorpay.

---

## 3. Investigation 2 (SEC-02): Unrestricted Coupon RPC Permissions

### 3.1 Vulnerability Mechanism
In `supabase/migrations/202607300012_coupon_atomic_claim.sql`:
- `claim_coupon(p_coupon_id UUID)` and `release_coupon(p_coupon_id UUID)` are defined with `SECURITY DEFINER SET search_path = ''`.
- **Zero privilege restrictions were applied.**
- In PostgreSQL, functions created in the public schema grant `EXECUTE` privilege to pseudo-role `PUBLIC` by default.
- Supabase automatically exposes all public schema functions over PostgREST at:
  - `POST /rest/v1/rpc/claim_coupon`
  - `POST /rest/v1/rpc/release_coupon`

### 3.2 Impact
- An anonymous attacker or malicious authenticated customer can send repeated requests with a targeted `coupon_id`.
- Each request increments `coupons.used_count`.
- Once `used_count >= max_uses`, legitimate customers attempting to book with the coupon are rejected with `"reason": "exhausted"`.
- Conversely, calling `release_coupon` allows unauthorized decrements down to zero.

### 3.3 Verification of Caller Surface
We inspected all client and server codebases:
- Mobile app (`apps/mobile`): **Zero calls** to `claim_coupon` or `release_coupon`.
- Organizer Web (`apps/organizer-web`): **Zero calls**.
- Admin Web (`apps/admin-web`): **Zero calls**.
- Edge Functions (`create-payment`, `cleanup-booking`, `reconcile-payments`): All connect via `SUPABASE_SERVICE_ROLE_KEY` (`service_role`).

### 3.4 Remediation Plan
Execute immediate privilege lockdown in a new SQL migration:
```sql
REVOKE ALL PRIVILEGES ON FUNCTION public.claim_coupon(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.release_coupon(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_coupon(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_coupon(UUID) TO service_role;
```
This completely eliminates the attack surface with zero impact on legitimate application flows.

---

## 4. Investigation 3 (SEC-03): Cloudinary Upload Security

### 4.1 Secret Management
- **Audit Result:** `CLOUDINARY_API_SECRET` is NOT present in mobile Dart files or web frontend source code. It is stored exclusively in Supabase backend environment variables.
- Only the public `cloud_name` and `upload_preset` are configured on client apps.

### 4.2 Client-Side Validation Rigor
Both clients execute strict validation before upload:
- **Mobile (`media_validator.dart`):** Validates magic numbers for JPEG, PNG, WebP, GIF, and enforces a 10MB limit.
- **Web (`cloudinary.ts`):** Validates magic numbers for images and container signatures for videos (`ftyp` for MP4/MOV, WebM, Ogg, QuickTime), enforcing 10MB image / 100MB video caps.

### 4.3 Direct API Bypass Vector
Because the preset is unsigned, any client can issue raw HTTP POST requests to `https://api.cloudinary.com/v1_1/<cloud_name>/image/upload` with `upload_preset`. If the Cloudinary dashboard allows unrestricted file types, an attacker can consume bandwidth or host unauthorized files.

### 4.4 Anti-Destruction Protection in `delete-media`
Media deletion via `supabase/functions/delete-media/index.ts` is strongly secured:
- Requires authenticated user JWT.
- Generates HMAC-SHA1 signature server-side.
- Prohibits deletion of active avatars (`profiles.avatar_url`), community assets (`banner_url`, `community_avatar_url`), and active event media.

### 4.5 Remediation Plan
1. **Immediate:** Configure Cloudinary Dashboard preset restrictions (allowed formats, max file sizes, automatic format conversion).
2. **Future Architecture:** Introduce an ephemeral signed upload Edge Function (`generate-upload-signature`) to deprecate unsigned presets entirely.

---

## 5. Cross-Stage Architectural Invariant Audit

All proposed fixes were verified against Cluvo's established core invariants:

1. **Global Lock Hierarchy:**
   - Level 1: `events`
   - Level 2: `registrations`
   - Level 3: `payments`
   - Level 4: `organizer_wallets` / `payout_items`
   - The proposed update to `cancel_registration_and_claim_refund` strictly adheres to Level 1 $\to$ Level 2 $\to$ Level 3 order, guaranteeing deadlock-free execution with concurrent bookings or admin cancellations.
2. **Stage 5 Event Cancellation Queue:**
   - Preserved. Bulk event cancellation jobs utilize the same lock hierarchy and status transitions.
3. **Stage 6 Attended Registration Invariant:**
   - Preserved. Any registration with `status = 'attended'` immediately aborts with `'not_refundable_attended'`.
4. **Stage 6 Financial Ledger Invariants:**
   - Integer paise calculations preserved.
   - Platform fee retention during customer self-cancellation strictly enforced.

---

## 6. Recommended Implementation Roadmap (Build Phase)

Following user review and transition to Build Mode, implementation should proceed in this exact sequence:

1. **Migration Step 1 (SEC-02):**
   - Create migration to revoke `PUBLIC, anon, authenticated` from `claim_coupon` and `release_coupon`, granting exclusively to `service_role`.
2. **Migration Step 2 (SEC-01):**
   - Enhance `cancel_registration_and_claim_refund` to accept registration ID, caller ID, reason, and optional custom refund amount, supporting both customer attendees and organizers.
3. **Edge Function Step (SEC-01):**
   - Update `supabase/functions/cancel-registration/index.ts` to call the enhanced atomic RPC and pass the resulting claim to `attemptRefund`.
4. **Verification Step:**
   - Execute test suites on `cluvo_test_stage6`:
     - Test crash window recovery in `reconcile-payments`.
     - Test coupon RPC rejection for `anon` and `authenticated`.
     - Test lock contention and attended ticket guards.

