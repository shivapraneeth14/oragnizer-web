# Cluvo — End-to-End Payment/Refund/Wallet/Account Flow Test Report

**Date:** 2026-11-02
**Environment:** Isolated local Supabase (full 166-migration schema), Razorpay test-mode keys available (not exercised for live money here — DB/RPC level E2E).
**Method:** Each feature driven through the real RPCs/Edge-Function logic, then **every column of every touched table** audited.

---

## 1. What was tested (and result)

### 1.1 Payment (pay → confirm)
**Scenario:** Mia pays ₹500 ticket + ₹30 fee for "Morning Yoga" (capacity 10).

| Check | Expected | Actual | Match |
|---|---|---|---|
| `payments.amount` | 53000 (₹530) | 53000 | ✅ |
| `payments.status` | success | success | ✅ |
| `payments.platform_fee` | 3000 (₹30) | 3000 | ✅ |
| `payments.organizer_share` | 50000 (₹500) | 50000 | ✅ |
| `payments.razorpay_payment_id` | set | pay_test_1 | ✅ |
| `registrations.status` | confirmed | confirmed | ✅ |
| `registrations.qr_code` | generated | `cluvo_…` | ✅ |
| `events.booked_count` | 1 | 1 | ✅ |
| `communities.wallet_balance` | +50000 | 50000 | ✅ |
| notification | "Booking Confirmed!" | present | ✅ |

**Bug found:** `payments.ticket_price` = **0** (should be ₹500). Never written by `create-payment` or `confirm_payment`.

### 1.2 Refund (self-cancel)
**Scenario:** Mia cancels a paid booking.

| Check | Expected | Actual | Match |
|---|---|---|---|
| refund amount | ticket only = 50000 (fee kept) | 50000 | ✅ |
| `payments.status` | refunded | refunded | ✅ |
| `payments.refund_status` | processed | processed | ✅ |
| `registrations.status` | cancelled, qr cleared | cancelled, null | ✅ |
| `events.booked_count` | 0 | 0 | ✅ |
| `communities.wallet_balance` | 0 (clawed back) | 0 | ✅ |

**Bug found:** `wallet_credited` and `wallet_debited` audit rows have `payment_id = NULL` (can't trace wallet to a specific payment).

### 1.3 Rebook (pay again after cancel)
**Scenario:** Mia cancels, then pays again for the same event.

| Check | Expected | Actual | Match |
|---|---|---|---|
| new order/payment id | new | order_test_2 / pay_test_2 | ✅ |
| no ghost refund | refund fields cleared | cleared | ✅ |
| `registrations.status` | confirmed | confirmed | ✅ |
| wallet | +50000 again | 50000 | ✅ |
| refund history preserved | 1 archived refund | present | ✅ |

✅ Rebook is correct — **but it triggers a payout bug (see §2.1).**

### 1.4 Payout (manual, offline — admin web)
**Scenario:** Admin records an offline transfer; organizer confirms.

**Whole-wallet payout (no event):** ✅ works — wallet 50000 → 0, status `success`, UTR stored.

**Event-specific payout:** ❌ **FAILS** after a cancel→rebook (see §2.1).

### 1.5 Ticket scanner authorization
✅ `check-in` Edge Function requires owner / `ORGANIZER` / `MODERATOR` / admin; others → 403 "This ticket belongs to another organizer's event."

### 1.6 Email uniqueness (Google sign-in)
✅ `profiles.email` is unique **case-insensitively** (`lower(email)`). Duplicate email → unique violation.

### 1.7 Account deletion
✅ Grace-period soft delete. `registrations.user_id` is `ON DELETE SET NULL` (booking/payment trail preserved, user link severed). Owner guard blocks deletion while owning communities.

### 1.8 Concurrency (tested earlier)
✅ Webhook claim (1 of 10), `confirm_payment` idempotency, capacity boundary, refund claim-guard — all safe.

---

## 2. Confirmed defects

### 🟠 HIGH — Payout "event payable balance" under-counts after cancel→rebook
**Scenario:** Customer pays → cancels (refund) → pays again (rebook reuses the same `payments` row). Organizer then tries an **event-specific** payout.

- **Expected:** organizer can withdraw the ₹500 they actually netted (wallet shows ₹500).
- **Actual:** payout rejected — `insufficient_event_payable_balance`, `event_available_payable = 0`.
- **Why:** the payout gross-earned query sums `payments.organizer_share` (one row = ₹500), but `payment_refund_history` still counts the earlier ₹500 refund as a debit. Because the rebook **reuses** the payment row instead of creating a new one, the original sale is invisible to the gross calc → `500 − 500 = 0`.
- **Impact:** **organizer cannot withdraw earned money** whenever a customer canceled and rebooked. (Whole-wallet payout is unaffected.)

### 🟡 MEDIUM — `payments.ticket_price` is always 0
- `create-payment` and `confirm_payment` never set `ticket_price` (defaults to 0). It's a dead/misleading column.

### 🟡 MEDIUM — Wallet audit rows lack `payment_id`
- `wallet_credited` / `wallet_debited` in `payment_audit_log` have `payment_id = NULL`, so wallet changes can't be traced to a specific payment. Only `refund_issued` carries `payment_id`.

### 🟢 LOW — `payment_confirmed` audit entry removed
- The latest `confirm_payment` (migration `202611010016`) no longer writes a `payment_confirmed` audit row (earlier versions did). Reconciliation/backfill that relied on it loses a signal.

### 🟢 LOW — `platform_fee_gst` null vs 0
- `pending` → `NULL`, `success` → `0` (inconsistent; no GST model exists).

### 🟢 Surface — `delete_user_auth_cascade` exposed to anon/authenticated
- proacl grants EXECUTE to anon/authenticated, but the function body raises `Permission denied` for non-`service_role`. Not exploitable, but should be `service_role`-only for defense-in-depth.

---

## 3. Security fixes already applied this session
- Payment-confirmation RPC privilege leak (payment bypass) — **fixed + deployed to test**.
- Admin refund resolver IDOR (`p_admin_id` vs `auth.uid()`) — **fixed + deployed to test**.

---

## 4. Untested / next
- Real Razorpay test-mode payment (order → pay → webhook) end-to-end.
- Failure injection (Razorpay timeout, DB mid-txn, worker crash).
- Realtime cross-portal update latency (customer↔organizer↔admin) and Flutter web screens.
- Full web-app UI (Playwright) starting states.
