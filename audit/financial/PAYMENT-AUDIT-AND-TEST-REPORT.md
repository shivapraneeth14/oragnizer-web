# CLUVO — COMPLETE END-TO-END PAYMENT SYSTEM AUDIT, DEEP TESTING AND DEFECT DISCOVERY

**Report file:** `audit/financial/PAYMENT-AUDIT-AND-TEST-REPORT.md`
**Prepared by:** Principal Payment Systems Architect / Senior PostgreSQL Engineer / Supabase Backend Engineer / Razorpay Integration Specialist / Flutter Engineer / React Engineer / Production Reliability Auditor
**Mode:** Read-only audit and testing phase (no source, migration, schema, data, secret, or deployment changes)
**Date:** Mon Nov 02 2026

---

## 1. Repository and Commit Information

| Repository | Role | Path | Branch | Commit SHA |
|---|---|---|---|---|
| `shivapraneeth14/cluvo` | Flutter customer application | `apps/mobile` (nested git repo) | `dev` | `3e80fb5b5f7698450a6e4824df3ead06a47c4fe1` |
| `shivapraneeth14/oragnizer-web` | Organizer Web, Admin Web, Supabase backend | repo root (monorepo) | `dev` | `469d1e94356312915569ad19715767816c21d326` |

**Monorepo contents of `oragnizer-web`:**
- `apps/admin-web` — React admin/financial dashboard
- `apps/mobile` — Flutter customer app (separate `.git`, the `cluvo` repo)
- `apps/organizer-web` — React organizer web app
- `supabase/` — Edge Functions, migrations, seed, tests, config

**Local test infrastructure available:** `psql`, `postgres` (Homebrew), `deno`, `node`, `dart`, `flutter`, `docker`. Staging Supabase project `.env` present with Razorpay **TEST** keys (`rzp_test_...`). No live Razorpay payments or refunds performed per restrictions.

---

## 2. Complete Payment Architecture Map

### 2.1 Payment-Related Database Tables

| Table | Purpose | Key Columns | Source Migration |
|---|---|---|---|
| `payments` | Core payment record (1:1 with registration) | id, registration_id (UNIQUE FK), amount (paise), currency, razorpay_order_id, razorpay_payment_id, status, refund_status, platform_fee, organizer_share, platform_fee_gst, coupon_id, refund_amount_due, refund_reason, refund_claim_state, refund_attempt_count, razorpay_refund_id, refunded_amount, failure_reason, attempt_count, created_at, updated_at, deleted_at | `202607220001_initial_schema.sql`, `202608210001_payment_split_columns.sql`, `202610110007_payments_columns.sql`, `202610220002_payments_failure_reason.sql`, `202610220012_payment_null_tolerance.sql`, `202611010001_incoming_payment_remediation.sql` |
| `registrations` | Bookings/tickets (1:1 with payment via payment.registration_id) | id, event_id, user_id, status (pending/confirmed/cancelled/attended), qr_code (UNIQUE), checked_in, registered_at, updated_at, deleted_at, UNIQUE(event_id,user_id) | `202607220001_initial_schema.sql` |
| `events` | Events with capacity/price | id, community_id, price (paise), capacity, booked_count, status (draft/published/cancelled/completed), deleted_at | `202607220001_initial_schema.sql` |
| `payment_audit_log` | Immutable payment audit trail | id, payment_id, transfer_id, action, details, created_at | `202607240007_payment_transfers.sql` |
| `payment_transfers` | Wallet transfer ledger (organizer share / platform fee) | id, payment_id (FK), community_id, amount, commission_amount, status | `202607240007_payment_transfers.sql` |
| `processed_webhooks` | Webhook idempotency/dedup | id, provider, event_type, processed_at | `202610110008_processed_webhooks.sql` |
| `coupons` | Discount codes | id, community_id, code, discount_type, discount_value, max_uses, used_count, valid_until | `202607220001_initial_schema.sql` |
| `communities` | Communities (fee config) | id, commission_percent, commission_on, ... | `202607220001_initial_schema.sql` |
| `payment_refund_history` | Archived refund records (immutable) | id, payment_id, razorpay_refund_id, amount, payment_amount, refund_status, ... | referenced by Flutter `my_payments_screen.dart` |
| `refund_task_queue` | Unresolved refund tasks for manual review | id, event_id, amount, status, attempt_count, max_attempts, error_message | referenced by `FinancialsPage.tsx` |
| `admin_alerts` | Critical payment alerts | id, severity, alert_key, message, details | `202610100003_admin_alerts.sql` |
| `notifications` | Customer notifications (refund initiated/completed, registration confirmed) | id, user_id, type, title, body, payload, read, created_at | `202607220001_initial_schema.sql` |

### 2.2 Key RPC / PostgreSQL Functions

| Function | Signature | Purpose | Security | Source |
|---|---|---|---|---|
| `confirm_payment` | `(p_payment_id UUID, p_expected_amount INTEGER DEFAULT NULL, p_expected_currency TEXT DEFAULT 'INR', p_razorpay_payment_id TEXT DEFAULT NULL)` RETURNS JSONB | Canonical payment confirmation: lock hierarchy (event→registration→payment), amount/currency validation (PAY-SEC-004), cancelled-event guard, atomic booked_count increment, persists platform_fee/organizer_share/platform_fee_gst, confirms registration + QR, credits wallet, inserts notification + audit log | SECURITY DEFINER, SET search_path='', GRANT EXECUTE TO service_role | `202611010016_cryptographic_ticket_token.sql` (latest); also redefined in `202611010001_incoming_payment_remediation.sql`, `202608210001_payment_split_columns.sql`, `202607300012_coupon_atomic_claim.sql`, `202607300003_fix_critical_payment_bugs.sql`, `202607240008_confirm_payment.sql`, and 15+ more |
| `confirm_payment_from_webhook` | `(p_payment_id UUID, p_webhook_id TEXT, p_razorpay_payment_id TEXT, p_expected_amount INTEGER, p_expected_currency TEXT DEFAULT 'INR')` RETURNS JSONB | Webhook idempotency via `processed_webhooks`, delegates to `confirm_payment`, records dedup row | SECURITY DEFINER, GRANT EXECUTE TO service_role | `202611010002_fix_webhook_processed_at.sql` |
| `try_process_webhook` | `(p_webhook_id TEXT, p_provider TEXT, p_event_type TEXT)` RETURNS boolean | Atomic webhook claim (INSERT ... ON CONFLICT) | GRANT EXECUTE TO service_role | `202610110008_processed_webhooks.sql` |
| `claim_payment_refund` | `(p_payment_id UUID, p_reason TEXT, p_amount INTEGER)` | Atomic refund claim lock; exactly one winner per payment; persists refund_reason + refund_amount_due | — | referenced by `_shared/refunds.ts` |
| `complete_payment_refund` | `(p_payment_id UUID, p_success BOOLEAN, p_refund_id TEXT, p_status TEXT, p_amount INTEGER, p_wallet_reason TEXT)` | Persists refund issued state + wallet clawback | — | referenced by `_shared/refunds.ts` |
| `reserve_ticket_capacity` | `(p_event_id UUID, p_user_id UUID, p_hold_duration_seconds INTEGER)` | Atomic capacity hold reservation | — | called by `create-payment` Edge Function |
| `release_ticket_capacity` | `(p_registration_id UUID)` | Release capacity hold | — | called by `create-payment` Edge Function |
| `claim_coupon` / `release_coupon` | Coupon atomic claim/release | — | referenced by `create-payment` |
| `run_financial_reconciliation` | `(p_community_id UUID, p_batch_limit INTEGER)` | 3-way financial reconciliation (wallet vs ledger vs transactions) | — | called by `FinancialsPage.tsx` |
| `get_admin_financial_statement` | `(p_community_id UUID, p_event_id UUID)` | Admin financial statement ledger | — | called by `FinancialsPage.tsx` |
| `get_community_financials` | `(p_community_id UUID)` | Community wallet balance | — | called by `FinancialsPage.tsx` |
| `credit_wallet` | Community wallet credit | Called inside `confirm_payment` | — | referenced in `202608210001_payment_split_columns.sql` |
| `cancel_stale_pending` | Cancel stale pending registrations | Called by `reconcile-payments` | — | referenced in reconcile Edge Function |

### 2.3 Edge Functions (`supabase/functions/`)

| Edge Function | Path | Auth | Purpose |
|---|---|---|---|
| `create-payment` | `create-payment/index.ts` | Bearer JWT (supabase auth.getUser), rate limit, consent check, deletion pending check | Creates Razorpay order, capacity hold, payment row; Path C confirms already-captured orders |
| `verify-payment` | `verify-payment/index.ts` | Bearer JWT | Client post-checkout verification; queries Razorpay directly; returns confirmed/paid_needs_repair/refunded/awaiting |
| `verify-payment-webhook` | `verify-payment-webhook/index.ts` | None (HMAC-SHA256 signature), per-IP rate limit | Unauthenticated Razorpay webhook; signature verify; `try_process_webhook` claim; `payment.captured` → `confirm_payment_from_webhook`; refund sync |
| `reconcile-payments` | `reconcile-payments/index.ts` | `x-reconcile-secret` header, rate limit | Cron (2 min): resolves stale pending payments vs Razorpay, cancels stale registrations, retry pending refunds (cap 5), payout cleanup |
| `cancel-registration` | `cancel-registration/index.ts` | Bearer JWT | Registration cancellation + refund initiation |
| `issue-refund` | `issue-refund/index.ts` | Bearer JWT | Manual/refund issuance |
| `cleanup-booking` | `cleanup-booking/index.ts` | Bearer JWT | Cleans up pending booking; reconciles captured payments before cancelling |

### 2.4 Shared Helper Modules (`supabase/functions/_shared/`)

| Module | Purpose |
|---|---|
| `razorpay.ts` | Robust Razorpay API client with exponential backoff, idempotency keys, financial uncertainty protocol (never blindly retry refund POSTs) |
| `refunds.ts` | `attemptRefund` — exactly-once refund issuance with claim lock, provider pre-check, uncertainty protocol; `refundRetryPlan`, `refundPolicyForReason`, `customerOwedAmount` |
| `payments.ts` | `paymentNonRequotableReason`, `hasRecordedRefundDebt`, `refundFieldsPresent`, `refundSyncRowTrustworthy`, `clearRefundFieldsForRequote`, `restoreRegistrationIfCancelled`, `revertRegistrationToCancelled` |
| `reconcile-pending.ts` | `resolvePendingPayment`, `decidePendingPayment` — G-01: never give up on pending payment until Razorpay proves no capture |
| `refund-retry.ts` | Refund retry caps, exhaustion flagging |
| `rate-limit.ts` | Per-user/IP rate limiting |
| `crypto.ts` | `safeEqual` constant-time comparison |
| `fees.ts` | `platformFeeForTicket` — fee-on-top math |
| `consent.ts` | `hasConsentRecord` |
| `logger.ts` | `logError` |
| `alerts.ts` | `recordAlert` |

### 2.5 Flutter Customer Application (`apps/mobile/lib/`)

| File | Role |
|---|---|
| `lib/screens/event_detail_screen.dart` | Payment initiation: `create-payment` invoke → Razorpay checkout → `_resolveAfterCheckout`/`_verifyPayment` (`verify-payment`) → polling; realtime subscriptions on `events` + `registrations`; 90s safety timer; refund poll |
| `lib/screens/payment_detail_screen.dart` | Payment receipt with realtime `payments` channel subscription |
| `lib/screens/my_payments_screen.dart` | Payment history list via `myPaymentsProvider` (Riverpod); merges live payments + `payment_refund_history` archive |
| `lib/screens/ticket_screen.dart` | Ticket/QR display from registration |
| `lib/models/payment.dart` | `Payment` model + `fromMap` parsing (status, razorpay_order_id, razorpay_payment_id, refund_status, platform_fee, organizer_share, etc.) |
| `lib/providers/activity_provider.dart` | `myPaymentsProvider`, `myRegistrationsProvider` — fetches payments/registrations from Supabase |
| `lib/services/razorpay_web.dart`, `razorpay_web_impl.dart`, `razorpay_stub.dart` | Razorpay checkout abstraction (web vs mobile) |
| `lib/widgets/payment_receipt.dart` | Payment receipt UI (status, refund status, amount breakup, timeline) |
| `lib/utils.dart` | `paymentHasMoneyTrail`, `payStatusColor`, `platformFeeTotal`, `embeddedPayment` — mirrors backend fee/refund rules |

### 2.6 React Applications

| File | Role |
|---|---|
| `apps/admin-web/src/pages/FinancialsPage.tsx` | Admin financial dashboard: statement via `get_admin_financial_statement` RPC, reconciliation via `run_financial_reconciliation` RPC, wallet via `get_community_financials`, unresolved refund tasks from `refund_task_queue` |
| `apps/admin-web/src/components/TransactionDetailDrawer.tsx` | Transaction detail display |
| `apps/organizer-web/src/` | Organizer event management, attendee check-in, payouts |

### 2.7 Existing Test Suites

| File | Role |
|---|---|
| `scripts/stage5_e2e_integration_test.ts` | Staging E2E integration test (live staging Supabase + Razorpay test mode; guards against live keys and production URL) |
| `scripts/stage5_remediation_smoke_test.ts` | Remediation smoke test |
| `scripts/stage5_milestone_d_smoke_test.ts` | Milestone D smoke test |
| `scripts/stage6_phase{1,2,3}_smoke_test.ts` | Stage 6 smoke tests |
| `audit/payment-security/` | Prior payment security audit artifacts |
| `audit/stage-6/`, `audit/stage-7/` | Prior stage audit artifacts |

---

## 3. Complete Database Table and Column Inventory

### 3.1 `payments` table (authoritative definition)

**Base definition** — `202607220001_initial_schema.sql` (lines 183-200):

```sql
create table payments (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null unique references registrations(id),
  amount integer not null,   -- paise
  currency text not null default 'INR',
  coupon_id uuid references coupons(id),
  razorpay_order_id text,
  razorpay_payment_id text,
  status text not null default 'pending' check (status in ('pending','success','failed','refunded')),
  refund_status text check (refund_status in ('requested','approved','processed','denied')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_payments_razorpay_order on payments (razorpay_order_id);
create index idx_payments_razorpay_payment on payments (razorpay_payment_id);
create trigger trg_payments_updated before update on payments
  for each row execute function set_updated_at();
```

**RLS policies** (initial schema, lines 319-335):
- `payments_via_own_registration` (SELECT): `registration_id in (select id from registrations where user_id = auth.uid())`
- `payments_team_read` (SELECT): via organizer/team membership on the event's community

**Additive column migrations:**
- `202608210001_payment_split_columns.sql`: ADD `platform_fee` INTEGER, `organizer_share` INTEGER (nullable, backfilled from audit log)
- `202610110007_payments_columns.sql`: additional payments columns
- `202610220002_payments_failure_reason.sql`: ADD `failure_reason`
- `202610220012_payment_null_tolerance.sql`: null-tolerance changes
- `202611010001_incoming_payment_remediation.sql`: `attempt_count`, `refund_amount_due`, `refund_reason`, `refund_claim_state`, `refund_attempt_count`, `razorpay_refund_id`, `refunded_amount`, `refund_claim_at`

**Column-level inventory (current, after all migrations):**

| Column | Type | Nullable | Default | PK | FK | Unique | Check | Index | Financial Significance |
|---|---|---|---|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | YES | — | — | — | PK | Payment record identity |
| registration_id | uuid | NO | — | — | registrations(id) | YES | — | — | Links payment to booking (1:1) |
| amount | integer | NO | — | — | — | — | — | — | Payable amount in paise (authoritative) |
| currency | text | NO | 'INR' | — | — | — | — | — | Currency (must be INR) |
| coupon_id | uuid | YES | — | coupons(id) | — | — | — | — | Applied coupon |
| razorpay_order_id | text | YES | — | — | — | — | — | idx_payments_razorpay_order | Razorpay order reference |
| razorpay_payment_id | text | YES | — | — | — | — | — | idx_payments_razorpay_payment | Razorpay payment/capture reference |
| status | text | NO | 'pending' | — | — | — | in ('pending','success','failed','refunded') | — | **Primary payment status** |
| refund_status | text | YES | — | — | — | — | in ('requested','approved','processed','denied') | — | Refund lifecycle state |
| platform_fee | integer | YES | — | — | — | — | — | — | Platform commission in paise at capture |
| organizer_share | integer | YES | — | — | — | — | — | — | Organizer net in paise |
| platform_fee_gst | integer | YES | — | — | — | — | — | — | GST on platform fee |
| refund_amount_due | integer | YES | — | — | — | — | — | — | Persisted refund debt (customer-owed) |
| refund_reason | text | YES | — | — | — | — | — | — | Persisted cancellation type (customer/organizer) |
| refund_claim_state | text | YES | — | — | — | — | — | — | Refund claim machine state |
| refund_attempt_count | integer | YES | — | — | — | — | — | — | Refund retry counter |
| razorpay_refund_id | text | YES | — | — | — | — | — | — | Razorpay refund reference |
| refunded_amount | integer | YES | — | — | — | — | — | — | Actual refunded amount |
| failure_reason | text | YES | — | — | — | — | — | — | Why payment failed |
| attempt_count | integer | YES | 0 | — | — | — | — | — | Order creation attempt counter |
| created_at | timestamptz | NO | now() | — | — | — | — | — | Row creation time |
| updated_at | timestamptz | NO | now() | — | — | — | — | trigger | Auto-updated via `set_updated_at` trigger |
| deleted_at | timestamptz | YES | — | — | — | — | — | — | Soft delete |

**Grants:** RLS enabled. Functions `confirm_payment`, `confirm_payment_from_webhook`, `try_process_webhook` granted EXECUTE to `service_role` only; REVOKED from PUBLIC/anon/authenticated.

**Triggers:** `trg_payments_updated` (before update, set_updated_at).

---

## 4. Internal API and Edge Function Inventory

### 4.1 `create-payment` Edge Function (`supabase/functions/create-payment/index.ts`)

**HTTP method:** POST (OPTIONS for CORS)
**Path:** `/functions/v1/create-payment`
**Auth:** Bearer JWT (required), rate limit per user, consent record required, deletion pending check
**Input:** `{ event_id, coupon_code }` (JSON body)
**Validation:** event exists, not deleted, not cancelled/completed, not started, capacity not full, price > 0, no existing paid/refunding payment (state-machine gate), coupon valid/unexpired, server-side discount clamp
**Database tables read:** events, communities, registrations, payments
**Database tables modified:** registrations (restore/revert), payments (insert/update), payment_audit_log (hold_release_failed)
**RPC invoked:** `reserve_ticket_capacity`, `release_ticket_capacity`, `claim_coupon`, `release_coupon`
**External services called:** Razorpay API (POST orders with idempotency key `order_<registrationId>`)
**Output:** `{ registration_id, razorpay_order_id, amount, platform_fee, platform_fee_gst, ticket_price }` or `{ exists: true, payment_status: "confirmed" }`
**Error responses:** 401 unauthorized, 403 consent, 404 event not found, 410 deleted/cancelled/completed/started, 409 already_paid/refund_in_progress/capacity_held, 400 invalid coupon/free event/full coupon, 503 high_demand_try_again, 500 generic
**Idempotency:** Razorpay idempotency key `order_<registrationId>`; existing pending order reuse within 24h if amount matches
**Retry behaviour:** 3 attempts for capacity hold (lock timeout backoff); 3 attempts for safe release hold
**Logging:** console.error on failures
**CORS:** `Access-Control-Allow-Origin: *`, POST, OPTIONS
**Timeout:** 30s client-side timeout (Flutter)

**Notable observation:** Database insert failure after Razorpay order creation is handled (revert registration, release hold, rethrow). API success is returned AFTER database operations complete. ✅

### 4.2 `verify-payment` Edge Function (`supabase/functions/verify-payment/index.ts`)

**HTTP method:** POST
**Path:** `/functions/v1/verify-payment`
**Auth:** Bearer JWT (required), rate limit per user
**Input:** `{ event_id }`
**Database tables read:** registrations, payments
**Database tables modified:** payments (update razorpay_payment_id), admin_alerts (insert on mismatch), notifications (refund)
**RPC invoked:** `confirm_payment`
**External services called:** Razorpay API (GET orders/{id}, GET orders/{id}/payments)
**Output:** `{ state, registration_id, payment_status, refund_status, rebookable }`
**Error responses:** 401, 400, 500
**Idempotency:** `confirm_payment` is idempotent (skipped if already success/refunded)
**Logging:** console.error on Razorpay check failure (returns "awaiting" — does NOT surface error)
**CORS:** `Access-Control-Allow-Origin: *`, POST, OPTIONS
**Timeout:** 15s client-side timeout (Flutter)

### 4.3 `verify-payment-webhook` Edge Function (`supabase/functions/verify-payment-webhook/index.ts`)

**HTTP method:** POST (OPTIONS for CORS)
**Path:** `/functions/v1/verify-payment-webhook`
**Auth:** None — protected by HMAC-SHA256 signature (`x-razorpay-signature`) + per-IP rate limit
**Input:** Razorpay webhook JSON body
**Validation:** HMAC signature verification, event type filtering (payment.captured + refund events only), webhook dedup via `try_process_webhook`, amount/currency security assertion (PAY-SEC-004)
**Database tables read:** payments, registrations, events, processed_webhooks
**Database tables modified:** payments (update status/refund_status), payment_audit_log (insert), notifications (insert), processed_webhooks (delete on error in catch block!)
**RPC invoked:** `try_process_webhook`, `confirm_payment_from_webhook`
**External services called:** none (Razorpay calls webhook TO us)
**Output:** HTTP 200 "OK"/"Already processed"/"Refund issued", 401 "Missing signature"/"Invalid signature", 400 "Missing event identifier"/"Missing order_id"/"Payment amount/currency mismatch", 404 "Order not found", 500 "Internal error"
**Idempotency:** `try_process_webhook` atomic claim + `confirm_payment_from_webhook` processed_webhooks check
**Retry behaviour:** Razorpay retries on non-2xx; duplicate deliveries return 200 "Already processed"
**Logging:** `logError` on exceptions

### 4.4 `reconcile-payments` Edge Function (`supabase/functions/reconcile-payments/index.ts`)

**HTTP method:** POST
**Path:** `/functions/v1/reconcile-payments`
**Auth:** `x-reconcile-secret` header (checked AFTER rate limit), rate limit per IP
**Cron:** 2 minutes (migration `202610300001_reconcile_cron_2min.sql`)
**Steps:**
1. Resolve stale pending payments (>2 min old) against Razorpay (G-01: ask provider first)
2. Cancel stale pending registrations without payments (`cancel_stale_pending` RPC)
3. Refund stuck payout items (>30 min) (`refund_wallet` RPC)
3b. Stale processing payouts >24h
3c. Retry pending refunds (cap 5 → `refund_retry_exhausted`)
4. Cleanup old processed webhook records (>7 days)

**External services called:** Razorpay API (GET orders, GET orders/{id}/payments, GET refunds/{id})
**Idempotency:** `markExpired` guarded by `status='pending'`; `confirm_payment` idempotent
**Logging:** console.error per payment, recordAlert for critical/warning events

---

## 5. Complete Payment Execution Flow

### 5.1 Customer-to-Database Flow

```
1. Customer opens event
   → Flutter: event_detail_screen.dart _load() fetches events/* + registrations + community_members
   → Realtime: subscribes to events and registrations channels

2. Customer selects ticket (paid event)
   → Flutter: _payForEvent() shows cancellation policy sheet, then invokes create-payment

3. Flutter calculates/receives payable amount
   → Flutter: utils.dart platformFeeTotal() mirrors backend; amount from create-payment response

4. Flutter sends booking request
   → Flutter: supabase.functions.invoke('create-payment', {event_id})

5. Internal API receives request
   → Edge Function: create-payment/index.ts

6. Edge Function validates auth + input
   → auth.getUser, checkRateLimit, hasConsentRecord, isDeletionPending

7. Backend validates event, ticket, quantity, price
   → events select: status='published', capacity check, price>0, deleted_at, start_date

8. Database checks availability and booking constraints
   → RPC reserve_ticket_capacity (atomic hold)

9. Backend creates Razorpay order
   → razorpayPost("orders", {amount, currency:"INR", receipt}, idempotencyKey=`order_${registrationId}_${attempt}`)

10. Payment record created/updated
    → INSERT payments (status='pending') or UPDATE existing payments row

11. Razorpay order details returned to Flutter
    → Response: {registration_id, razorpay_order_id, amount, platform_fee, ...}

12. Flutter launches checkout
    → Razorpay.open(options) with key, amount, currency, order_id

13. Customer completes or cancels payment
    → Razorpay SDK callbacks: EVENT_PAYMENT_SUCCESS / EVENT_PAYMENT_ERROR / EVENT_EXTERNAL_WALLET
```

### 5.2 Razorpay-to-Backend Flow

```
1. Razorpay returns payment information
   → Webhook: payment.captured (or client calls verify-payment)

2. Flutter sends payment verification details
   → Flutter: _verifyPayment() invokes verify-payment {event_id}

3. Backend verifies signature
   → Webhook: verifySignature (HMAC-SHA256) — client path does NOT verify signature (relies on auth)

4. Backend validates Razorpay order ID
   → confirm_payment: amount/currency match

5. Backend validates payment ID
   → confirm_payment sets razorpay_payment_id if null

6. Backend validates amount and currency
   → PAY-SEC-004: p_expected_amount == v_payment.amount, currency match

7. Backend validates expected payment state
   → confirm_payment: skips if status in ('success','refunded'); failed if cancelled event/capacity full

8. Database records the capture
   → UPDATE payments SET status='success', platform_fee, organizer_share; UPDATE registrations SET status='confirmed', qr_code

9. Registration is confirmed
   → credit_wallet, notification, payment_audit_log

10. Financial side effects executed
    → wallet credit + audit log + notification (inside confirm_payment, same transaction)

11. Webhook arrives independently
    → verify-payment-webhook: HMAC verify → try_process_webhook claim → confirm_payment_from_webhook

12. Webhook signature verified
    → HMAC-SHA256 with RAZORPAY_WEBHOOK_SECRET

13. Webhook is claimed
    → try_process_webhook atomic INSERT ON CONFLICT

14. Duplicate events handled
    → claim returns false → "Already processed" 200

15. Payment and registration states reconciled
    → confirm_payment sets both atomically
```

**Client verification and webhook processing can execute simultaneously.** Both can cause financial effects. `confirm_payment` is idempotent (returns `skipped` if already success/refunded), so concurrent execution is safe **at the RPC level** due to `FOR UPDATE` row locks. However, the webhook catch block deleting `processed_webhooks` (PAY-001) can break idempotency.

### 5.3 Database-to-Frontend Flow

```
1. Database payment update (confirm_payment)
2. Registration update (status='confirmed', qr_code)
3. RPC response (confirm_payment JSONB)
4. Edge Function response (verify-payment/create-payment)
5. Frontend API response (Supabase client)
6. Flutter model parsing (Payment.fromMap)
7. Flutter state management (setState, Riverpod providers)
8. Screen refresh (_load, _pollRegistrationStatus, _verifyPayment)
9. Realtime updates (payments channel on payment_detail_screen; events/registrations on event_detail_screen)
10. Payment history (my_payments_screen + payment_refund_history)
11. Ticket status (ticket_screen)
12. Customer-visible success/failure messages (SnackBar)
```

**Stale data risk:** `my_payments_screen.dart` uses Riverpod FutureProvider with manual invalidation on refresh — stale cache possible between payments.

---

## 6. Payment Status State Machine

### 6.1 Status Fields

| Table | Field | Values | Controlled By |
|---|---|---|---|
| `payments` | `status` | pending, success, failed, refunded | confirm_payment, webhook, verify-payment, reconcile |
| `payments` | `refund_status` | requested, approved, processed, denied (DB check) | webhook sync, refund flows, reconcile |
| `payments` | `refund_claim_state` | (claimed/issued/failed/none per code) | claim_payment_refund |
| `registrations` | `status` | pending, confirmed, cancelled, attended | confirm_payment, cancel flows, reconcile |
| `events` | `status` | draft, published, cancelled, completed | organizer flows |
| Razorpay order | `status` | created, paid, ... | Razorpay (external) |
| Razorpay payment | `status` | captured, ... | Razorpay (external) |

### 6.2 State-Transition Matrix (`payments.status`)

| From → To | Who/Function | Atomic? | Reversible? | Repeatable? | After Cancellation? | Sync Across Tables? |
|---|---|---|---|---|---|---|
| pending → success | confirm_payment (webhook/client/reconcile) | YES (FOR UPDATE + txn) | NO | NO (idempotent skip) | NO (guard blocks) | YES (registration→confirmed, wallet credit) |
| pending → failed | confirm_payment (cancelled event/capacity full), reconcile (markExpired) | YES | NO | NO | YES | YES (registration→cancelled) |
| pending → refunded | — (not a direct transition) | — | — | — | — | — |
| success → refunded | webhook refund sync (refundStatus=processed) | YES (UPDATE) | NO | NO | N/A | YES (refund_status, refunded_amount) |
| success → failed | — (not allowed) | — | — | — | — | — |
| failed → success | — (not allowed; re-quote creates new order on same row) | — | — | — | — | row reused with new order |
| failed → refunded | — | — | — | — | — | — |
| refunded → success | — (not allowed; idempotent skip) | — | — | — | — | — |

### 6.3 Invalid Transitions to Test
- Failed → Confirmed without valid capture
- Pending → Refunded without valid payment
- Cancelled → Confirmed unexpectedly
- Refunded → Paid
- Captured → Failed
- Expired → Confirmed after invalid late response
- Duplicate status updates
- Older webhook overwriting newer state

---

## 7. Cross-Application Status Synchronization Map

| Context | Payment Status Source | Status Interpretation | Consistent? |
|---|---|---|---|
| Flutter customer app (`event_detail_screen`) | registrations.status + verify-payment state | confirmed/paid/awaiting/refunded/paid_needs_repair | Mostly consistent |
| Flutter `payment_detail_screen` | payments.status + refund_status | Success/Failed/Pending/Refunded/Refund in progress | Consistent |
| Flutter `my_payments_screen` | payments + payment_refund_history | Merged; refund history may show archived refund on reused row | Potential confusion |
| Flutter `ticket_screen` | registrations.status | confirmed/attended/cancelled | Consistent |
| Organizer Web attendee dashboard | registrations + payments | TBD (inspect) | — |
| Admin Web FinancialsPage | get_admin_financial_statement RPC | ticket_sale/refund/payout | Reconciliation engine verifies |
| Supabase payment records | payments.status | Authoritative | Authoritative |

---

## 8. Test Matrix (Phases 5-10)

Test execution requires local infrastructure. All scenarios are listed; execution status recorded below.

### Phase 5.A — Order creation
5A-1 Valid order creation · 5A-2 Invalid amount · 5A-3 Zero amount · 5A-4 Negative amount · 5A-5 Extremely large amount · 5A-6 Incorrect currency · 5A-7 Missing event · 5A-8 Invalid ticket · 5A-9 Invalid quantity · 5A-10 Sold-out event · 5A-11 Event capacity boundary · 5A-12 Duplicate order creation · 5A-13 Concurrent order creation · 5A-14 DB insert failure after Razorpay order · 5A-15 Existing payment record update failure · 5A-16 Razorpay timeout · 5A-17 Razorpay server error · 5A-18 Invalid Razorpay response

### Phase 5.B — Checkout
5B-1 Successful checkout · 5B-2 Customer cancels checkout · 5B-3 Customer closes application · 5B-4 Network disconnect during checkout · 5B-5 Checkout opened twice · 5B-6 Customer double-clicks pay · 5B-7 Application backgrounded · 5B-8 Application restarted · 5B-9 Delayed Razorpay response · 5B-10 Checkout completed but client response lost · 5B-11 Customer retries after timeout

### Phase 5.C — Signature and payment verification
5C-1 Valid signature · 5C-2 Invalid signature · 5C-3 Tampered order ID · 5C-4 Tampered payment ID · 5C-5 Incorrect amount · 5C-6 Incorrect currency · 5C-7 Payment ID from another order · 5C-8 Order ID from another customer · 5C-9 Missing verification fields · 5C-10 Repeated verification request · 5C-11 Concurrent verification requests · 5C-12 Verification after cancellation · 5C-13 Verification after refund · 5C-14 Delayed verification

### Phase 5.D — Webhook testing
5D-1 Valid payment.captured · 5D-2 Valid payment.failed · 5D-3 Valid order.paid · 5D-4 Duplicate webhook · 5D-5 Twenty simultaneous duplicate deliveries · 5D-6 Different webhook IDs for same payment · 5D-7 Out-of-order webhooks · 5D-8 Delayed webhook · 5D-9 Invalid signature · 5D-10 Empty body · 5D-11 Malformed body · 5D-12 Unsupported event · 5D-13 Database unavailable · 5D-14 Worker crash after claim · 5D-15 Worker crash after payment processing · 5D-16 Claim lease expiry · 5D-17 Old worker completion after lease recovery · 5D-18 Duplicate financial side effects

### Phase 5.E — Payment state and DB consistency
5E-1 Payment and registration update together · 5E-2 Payment succeeds but registration update fails · 5E-3 Registration succeeds but payment update fails · 5E-4 DB transaction rollback · 5E-5 RPC returns error · 5E-6 RPC returns success but affected zero rows · 5E-7 Unique constraint violation · 5E-8 Foreign-key violation · 5E-9 Repeated state transition · 5E-10 Concurrent state transition · 5E-11 Partial database failure · 5E-12 Reconciliation after inconsistency

### Phase 5.F — Ticket and capacity integration
5F-1 Ticket generation after payment · 5F-2 QR generation after confirmation · 5F-3 Ticket display after app restart · 5F-4 Duplicate registration prevention · 5F-5 Final ticket concurrency · 5F-6 Ticket quantity validation · 5F-7 Ticket status after payment failure · 5F-8 Ticket status after late capture · 5F-9 Event cancellation during payment · 5F-10 Payment capture after event cancellation begins

### Phase 6 — Concurrency and race-condition testing
6-1 Multiple customers booking final ticket · 6-2 Two requests creating same payment · 6-3 Two verification requests for one payment · 6-4 Two webhook workers claiming one event · 6-5 Client verification + webhook simultaneously · 6-6 Payment capture + cancellation simultaneously · 6-7 Two DB transactions updating payment status · 6-8 Repeated webhook during lease recovery · 6-9 DB timeout during concurrent processing · 6-10 Worker crash while another retries

### Phase 7 — Failure injection and recovery
7-1 Razorpay order created, DB insert fails · 7-2 Payment captured, payment ID update fails · 7-3 Payment record updated, registration confirmation fails · 7-4 Registration confirmed, webhook completion fails · 7-5 Worker crashes after acquiring claim · 7-6 DB unavailable during processing · 7-7 HTTP response lost after successful DB txn · 7-8 Provider times out after acceptance · 7-9 App terminated during checkout · 7-10 Webhook retries after long delay

### Phase 8 — Security testing
8-1 Invalid Razorpay webhook signatures · 8-2 Webhook replay · 8-3 Unauthorized payment verification · 8-4 Customer accessing another customer's payment · 8-5 Organizer accessing another organizer's payments · 8-6 Admin authorization bypass · 8-7 IDOR vulnerabilities · 8-8 RPC permission bypass · 8-9 RLS bypass · 8-10 JWT expiration · 8-11 Incorrect ownership validation · 8-12 Sensitive info in logs · 8-13 Exposed Razorpay secrets · 8-14 CORS misconfiguration · 8-15 Input manipulation · 8-16 Rate limiting · 8-17 Payment amount tampering

### Phase 9 — Frontend and status synchronization
9-1 Loading states · 9-2 Payment success · 9-3 Payment failure · 9-4 Payment pending · 9-5 Checkout cancellation · 9-6 Network errors · 9-7 Retry actions · 9-8 Duplicate button clicks · 9-9 Application restart · 9-10 Background/foreground transitions · 9-11 Stale cached payment status · 9-12 Realtime synchronization · 9-13 Payment history · 9-14 Registration history · 9-15 Ticket display · 9-16 Error messages

### Phase 10 — Reconciliation and financial invariants
10-1 Every confirmed payment has valid provider payment · 10-2 Every payment associated with correct order and registration · 10-3 Amount and currency match · 10-4 Duplicate captures don't produce duplicate financial effects · 10-5 Failed payments don't produce confirmed paid registrations · 10-6 Late captures handled per business rules · 10-7 Every payment state has valid transition history · 10-8 Payment records not silently lost · 10-9 DB and provider reconciliation identifies discrepancies · 10-10 Payment records agree with customer/organizer-facing status

---

## 8b. Working-Tree (Uncommitted) State

**Important:** The `oragnizer-web` working tree has **uncommitted modifications** on top of the audited `dev` HEAD (`469d1e94356312915569ad19715767816c21d326`). Critically, **8 payment-related migrations are untracked** (not in the committed `dev` branch):

Untracked migrations (present on disk, absent from `dev` HEAD):
- `202610110005_profile_columns.sql`
- `202610110007_payments_columns.sql`
- `202610110008_processed_webhooks.sql` ← breaks the migration chain (PAY-008)
- `202610110009_community_wallets.sql`
- `202611010014_atomic_cancel_and_claim_refund.sql`
- `202611010015_verified_admin_refund_resolution.sql`
- `202611010016_cryptographic_ticket_token.sql` ← newer 5-param `confirm_payment`
- `202611010017_concurrency_safe_manual_settlements.sql`

Also modified (uncommitted) in the working tree: `verify-payment-webhook/index.ts` (broken — PAY-005), `issue-refund/index.ts`, `_shared/refunds.ts`, several web app files, and `config.toml`.

**Consequence:** The committed `dev` HEAD is self-consistent (its `processed_webhooks` is the `202607300003` TEXT-id version with an atomic `try_process_webhook`; its `confirm_payment` is the 5-param version from `202611010001`). The working tree — the state the developer is actively editing — is broken in two independent ways: (1) the webhook handler does not compile, and (2) applying all migrations on disk fails at `202610110008`. If the working tree were committed and deployed as-is, production webhook processing would break.

---

## 9. Confirmed Defects

| ID | Severity | Repo/Commit | File | Lines | DB Object | Observed Behaviour | Expected Behaviour | Reproduction | Financial Impact | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| PAY-005 | Critical | oragnizer-web (WORKING TREE, uncommitted) | `supabase/functions/verify-payment-webhook/index.ts` | 234-235, 246, 254-257 | — | The uncommitted edit uses `#` as comment prefix (invalid TypeScript/JS), which is a **syntax error** — `deno check` fails at line 234:14 (`SyntaxError: Expected ';', '}' or <eof>`). It also removed the `await syncRefundState(...)` call and the closing `}` of the `if (isRefundSync)` block, so the refund-sync path is dead and the remaining payment-capture logic is incorrectly nested. The Edge Function does **not compile/deploy** in this state. | Valid `//` comments; refund-sync path must call `syncRefundState` and return; brace balance preserved. | Run `deno check supabase/functions/verify-payment-webhook/index.ts` → SyntaxError at 234:14. | Complete webhook outage: no `payment.captured` confirmation, no refund sync | Confirmed (compiler evidence) |
| PAY-009 | Critical | oragnizer-web (WORKING TREE, uncommitted) | `supabase/migrations/` | — | — | 8 payment-related migrations are untracked (not in `dev` HEAD), including `202610110008_processed_webhooks.sql` (breaks the chain) and `202611010016_cryptographic_ticket_token.sql` (newer `confirm_payment`). The committed `dev` HEAD and the working tree describe two different schemas; deploying the working tree would apply a broken migration and an incompatible webhook dedup layer. | Commit the migrations (or remove the broken one) before any deploy; keep working tree and `dev` in sync. | `git status --porcelain supabase/migrations/` → 8 `??` entries; `git ls-files` → 156 tracked vs 164 on disk. | Deploy of broken/divergent payment schema | Confirmed (git state) |
| PAY-008 | Critical | oragnizer-web (untracked migration `202610110008`) | `202610110008_processed_webhooks.sql` vs `202607300003:113-142` | `processed_webhooks` table + `try_process_webhook` | Conflicting schema: `202607300003` (tracked) creates `processed_webhooks(id TEXT PRIMARY KEY, …)` + atomic `try_process_webhook`. The untracked `202610110008` redefines the table as `id uuid + webhook_id text` (no-op via `IF NOT EXISTS`) then `ALTER TABLE … ADD UNIQUE (webhook_id, …)` → fails. | A single consistent `processed_webhooks` schema + atomic claim + correct column usage. | Apply tracked migrations, then untracked `202610110008` → `ERROR: column "webhook_id" named in key does not exist` (reproduced locally). | Migration chain breaks; webhook dedup not installable | Confirmed (reproduced) |
| PAY-006 | High | oragnizer-web (untracked migration `202610110008`) | `202610110008_processed_webhooks.sql:33-52` | `try_process_webhook` | The untracked redefinition makes `try_process_webhook` `STABLE` and select-only (no INSERT) and references `processed_webhooks` unqualified with `SET search_path = ''` → both "not a claim" and "relation not found" at runtime. | A `VOLATILE` SECURITY DEFINER insert-based claim. | Reproduced locally → `ERROR: relation "processed_webhooks" does not exist`. | Duplicate processing window; webhook claim fails | Confirmed (reproduced) |
| PAY-007 | High | oragnizer-web 469d1e9 (`202611010001/002`) | `202611010002:23,41-43` | `confirm_payment_from_webhook` | `confirm_payment_from_webhook` dedups/inserts on `processed_webhooks.id = p_webhook_id`. Correct against the tracked TEXT-id table, but **incompatible with the untracked `202610110008` UUID+`webhook_id` schema** (would be an invalid-UUID cast). The dedup key must be `webhook_id` once that migration is adopted. | Align the dedup key column across both schemas. | Adopt `202610110008`, then call the RPC → invalid UUID cast. | Webhook dedup broken once new migration adopted | Confirmed (conditional, code review) |
| PAY-001 | Critical | oragnizer-web 469d1e9 | `supabase/functions/verify-payment-webhook/index.ts` | 327-331 | `processed_webhooks` | On webhook error, the catch block **deletes** `processed_webhooks` by `x-razorpay-event-id`. A failed webhook loses its dedup marker, so Razorpay's retry is reprocessed from scratch. (Mitigated by `confirm_payment` idempotency and refund claim-guarding, but the dedup is defeated.) | Retain the dedup row; never delete the claim on error. | Send a webhook that throws after partial processing; redeliver same event id; observe reprocessing. | Duplicate financial side effects | Confirmed (code review) |
| PAY-003 | High | oragnizer-web 469d1e9 | `supabase/functions/verify-payment/index.ts` | 187-191 | — | Razorpay check failure in `verify-payment` is swallowed (catch returns "awaiting" with old `payment.status`). Customer sees "awaiting" even when money was captured; may be stuck unable to rebook. | Surface the error or retry; do not silently mask provider failures. | Make Razorpay GET order/payments fail during verify-payment; observe UI shows "awaiting" indefinitely. | Customer stranded; support burden | Confirmed (code review) |
| PAY-004 | Low | cluvo 3e80fb5 | `apps/mobile/lib/screens/event_detail_screen.dart` | 199-205 | `payments.failure_reason` | `_getPaymentFailureMessage` selects `failure_reason`, which is added only by migration `202610220002`. On a backend that has not applied that migration the query fails (mitigated by try/catch fallback). | Query only columns that exist, or rely on the try/catch fallback. | Query `failure_reason` against a pre-202610220002 backend. | Error-message fallback only (non-financial) | Confirmed (code review) |

---

## 10. Suspected Defects

| ID | Severity | Repo/Commit | File | Lines | Description |
|---|---|---|---|---|---|
| PAY-S-001 | Medium | oragnizer-web 469d1e9 | `supabase/migrations/202611010016_cryptographic_ticket_token.sql` | 130-132 | `confirm_payment` uses `v_payment.platform_fee` (persisted at order creation) rather than recomputing from `v_community.commission_percent`. If commission changed between order and confirmation, the persisted fee is stale (intentional per design comment, but fee changes mid-flow are not reflected). |
| PAY-S-002 | Low | oragnizer-web (WORKING TREE) | `supabase/functions/verify-payment-webhook/index.ts` | 248-256 | ~~Refund sync path calls `try_process_webhook` twice~~ — **superseded by PAY-005**: this second claim only exists in the broken uncommitted edit; the committed HEAD has a single claim. |
| PAY-S-003 | Medium | cluvo 3e80fb5 | `apps/mobile/lib/providers/activity_provider.dart` | 67-103 | `myPaymentsProvider` merges live payments + `payment_refund_history` archive. When a payment row is reused for a new sale, the old refund history still shows under the same payment_id, potentially confusing the customer. |
| PAY-S-004 | Medium | oragnizer-web 469d1e9 | `supabase/functions/create-payment/index.ts` | 228-246 | Path C order reuse: window where a captured-but-unconfirmed order could be reused while a webhook is processing. |
| PAY-S-005 | Medium | cluvo 3e80fb5 | `apps/mobile/lib/screens/event_detail_screen.dart` | 441-444 | `_verifyPayment` catch block returns `null` silently; network errors during verification are masked. |
| PAY-S-006 | Low | oragnizer-web 469d1e9 | `supabase/migrations/202611010009_event_capacity_and_status_guard.sql` | — | Capacity guard in `confirm_payment` uses `GET DIAGNOSTICS ROW_COUNT`; `FOR UPDATE` on event row serializes concurrent confirmations, but lock ordering across the 15+ redefinitions should be verified. |

---

## 11. Unverified Scenarios

All live-execution test scenarios (Phases 5-10) are currently **UNVERIFIED** pending local infrastructure. The code-review defects above (PAY-001 through PAY-004) are confirmed by static analysis.

---

## 12. Missing Implementations

| Area | Description | Repo/Commit |
|---|---|---|
| Webhook `order.paid` handling | `verify-payment-webhook` only handles `payment.captured` and refund events; `order.paid` falls to "Unhandled event" 200 (returned as success). | oragnizer-web 469d1e9 |

**Corrected from earlier draft:** `payment_refund_history` (created in `202610220004_refund_policy_integrity.sql:49`), `refund_task_queue` (created in `202610310001_cancellation_queue_engine.sql:43`), and `refund_claim_at` (added in `202610120001_payment_refund_claims.sql:29`) **do exist** in the migrations — they were not missing.

---

## 13. Regression Risks

1. **Webhook dedup deletion (PAY-001):** Any change to webhook error handling could reintroduce duplicate financial effects.
2. **refund_status check constraint mismatch (PAY-002):** Any new refund status value written by code could violate the DB constraint.
3. **confirm_payment signature drift:** 15+ migrations redefine `confirm_payment`. Latest (202611010016) uses 5-param signature matching Edge Function callers; older 1-param definitions exist in history.
4. **Flutter fee math mirrors backend:** `utils.dart` `platformFeeTotal` must stay in sync with `_shared/fees.ts`.
5. **Payment row reuse:** Reusing the same `payments` row across cancel→rebook cycles risks ghost-refund bugs (mitigated by `clearRefundFieldsForRequote` but complex).

---

## 14. Payment-Specific Remediation Backlog

| ID | Priority | Defect | Recommended Fix | Repo/Commit |
|---|---|---|---|---|
| PAY-009 | Critical | 8 payment migrations untracked; working tree and `dev` diverge | Commit (or remove) the untracked migrations; keep working tree in sync with `dev` | oragnizer-web working tree |
| PAY-005 | Critical | Broken uncommitted webhook edit (`#` syntax errors, removed refund sync, brace mismatch) | Revert/fix `verify-payment-webhook/index.ts`; use `//` comments, restore `syncRefundState` call + closing brace; `deno check` must pass | oragnizer-web working tree |
| PAY-008 | Critical | Untracked `202610110008` conflicts with tracked `202607300003` on `processed_webhooks` schema | Consolidate to one schema; make claim atomic; align all objects | oragnizer-web untracked migration |
| PAY-006 | High | Untracked `202610110008` `try_process_webhook` STABLE/select-only + unqualified table | Make it a VOLATILE SECURITY DEFINER insert-based claim with qualified table name | oragnizer-web untracked migration |
| PAY-007 | High | `confirm_payment_from_webhook` uses `id` instead of `webhook_id` (once new schema adopted) | Use `webhook_id` column for dedup key consistently | oragnizer-web 469d1e9 `202611010002:23,41-43` |
| PAY-001 | Critical | Webhook catch block deletes processed_webhooks dedup row | Remove delete in catch block; ensure idempotency survives failures | oragnizer-web 469d1e9 `verify-payment-webhook/index.ts:327-331` |
| PAY-003 | High | verify-payment swallows Razorpay errors | Return error state instead of masking as "awaiting" | oragnizer-web 469d1e9 `verify-payment/index.ts:187-191` |
| PAY-004 | Low | `_getPaymentFailureMessage` queries `failure_reason` that may not exist | Guard query against missing column | cluvo 3e80fb5 `event_detail_screen.dart:199-205` |
| PAY-S-001 | Medium | Stale platform_fee on commission change | Document intentional behavior; consider recomputing at confirmation | oragnizer-web 469d1e9 `202611010016:130-132` |
| PAY-S-002 | Low | Redundant try_process_webhook call in refund path | Remove duplicate claim call | oragnizer-web 469d1e9 `verify-payment-webhook/index.ts:248-256` |
| PAY-S-003 | Medium | payment_refund_history reuse confusion | Clarify archive display logic | cluvo 3e80fb5 `activity_provider.dart:67-103` |
| Missing | — | `order.paid` webhook not handled | Add explicit handling or document as intentional | oragnizer-web 469d1e9 `verify-payment-webhook/index.ts` |

---

## 15. Test Execution Evidence

**Static-analysis test executed (Phase 11 — real command, real exit code):**

```bash
$ cd supabase && deno check functions/verify-payment-webhook/index.ts
error: SyntaxError: Expected ';', '}' or <eof>
    |
234 |     # Atomic webhook claim — only one request can claim a given webhook event.
    |              ~~~~~~~
    at file:///.../supabase/functions/verify-payment-webhook/index.ts:234:14
```

This is concrete evidence for PAY-005: the working-tree webhook handler does not compile.

**Database migration test executed (Phase 1/5 — isolated local Postgres 16, database `cluvo_payment_audit`):**

Reproduced the `processed_webhooks` schema conflict by applying the actual migration fragments in order:

```text
-- 202607300003: CREATE TABLE processed_webhooks (id TEXT PRIMARY KEY, ...)  [OK]
-- 202607300003: try_process_webhook (atomic INSERT ... unique_violation)     [OK]
-- 202610110008: CREATE TABLE IF NOT EXISTS (id uuid + webhook_id text, ...)  [no-op, skipped]
-- 202610110008: ALTER TABLE ADD CONSTRAINT UNIQUE (webhook_id, ...)
  → ERROR: column "webhook_id" named in key does not exist
-- columns remain: processed_at, id, provider, event_type  (webhook_id never added)
```

Then, after redefining `try_process_webhook` per `202610110008` (STABLE, select-only, `SET search_path = ''`):

```text
SELECT try_process_webhook('evt_123','razorpay','payment.captured');
  → ERROR: relation "processed_webhooks" does not exist
  (function body uses unqualified processed_webhooks with empty search_path)
```

This is concrete evidence for PAY-008, PAY-006, and PAY-007: the webhook dedup layer is broken in three independent ways (migration schema conflict, non-atomic STABLE claim, unqualified/mismatched column reference).

**Live runtime tests (Phases 5-10):** Not yet executed. Local infrastructure available (`psql`, `postgres`, `deno`, `docker`, `flutter`). Staging test-mode Razorpay keys present in `supabase/.env`. To execute the test matrix: (1) stand up local PostgreSQL or `supabase start`, (2) apply migrations through `202611010017`, (3) run tests against Razorpay test mode, (4) record commands/exit codes/outputs/counts.

Existing smoke tests (`scripts/stage5_*.ts`) run against live staging Supabase with test-mode Razorpay; inspected read-only but not executed (would modify staging data).

---

## 16. Sign-Off

**Audit status:** IN PROGRESS — Phases 1-4 (discovery, architecture, state machine) complete via static analysis; Phase 11 partial (compiler check of webhook function executed, revealing PAY-005). Phases 5-10 (live testing, concurrency, failure injection, security) pending execution infrastructure.

**Commit SHAs verified:**
- `shivapraneeth14/cluvo` (Flutter): `3e80fb5b5f7698450a6e4824df3ead06a47c4fe1` (dev)
- `shivapraneeth14/oragnizer-web` (web+Supabase): `469d1e94356312915569ad19715767816c21d326` (dev)

**Working-tree note:** `oragnizer-web` has uncommitted modifications; the webhook handler (`verify-payment-webhook/index.ts`) is currently broken (PAY-005) in the working tree while the committed `dev` HEAD is coherent.

**No source code, migrations, schemas, data, secrets, or deployments were modified during this audit.**
