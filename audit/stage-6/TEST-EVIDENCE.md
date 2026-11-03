# Physical Test Execution Evidence: Cluvo Stage 6

This document presents the unedited test execution results, assertion counts, and live logs for all test suites executed in support of Cluvo Stage 6 remediation and verification.

---

## 1. Test Execution Summary

| Test Suite | Environment / Engine | Scope | Tests Run | Tests Passed | Tests Failed |
| :--- | :--- | :--- | :---: | :---: | :---: |
| **Physical DB Concurrency & Refund Integrity** | Local PostgreSQL (`cluvo_test_stage6`) | Concurrency, Lock Ordering, REF-001..004, REV-REF-001..005 | 43 | 43 | 0 |
| **Physical Manual Settlement Concurrency** | Local PostgreSQL (`cluvo_test_stage6`) | Double-debits, race conditions, event limits, VER-MS-001..003 | 45 | 45 | 0 |
| **Database Migration Integrity Gate** | Deno Test Runtime | Migrations 0001–0017 static & schema syntax invariants | 31 | 31 | 0 |
| **Refund Remediation & Razorpay Provider Gate**| Deno Test Runtime | Mocked Razorpay API responses & Edge Function verification | 8 | 8 | 0 |
| **Admin Web Frontend Suite** | Node.js / Vitest / MSW | Admin financials, dispute resolution, manual payouts | 40 | 40 | 0 |
| **Organizer Web Frontend Suite** | Node.js / Vitest / MSW | Organizer payouts, confirmation, check-in, event form | 26 | 26 | 0 |
| **Mobile Flutter Client Suite** | Flutter Test Engine | Deep-link routing and refund detail screens | 3 | 3 | 0 |
| **TOTAL** | | | **196** | **196** | **0** |

---

## 2. Test Suite 1: Physical PostgreSQL Database Concurrency & Refund Suite
- **Command**: `node tests/stage6_db_concurrency_test.cjs`
- **Database**: `postgres://shivapraneeth@localhost:5432/cluvo_test_stage6`
- **Result**: **43 / 43 PASSED**

```text
--- 1. Initializing Isolated Schema & Dependencies ---
  Base schema tables and mock wallet functions created successfully.
  Applied migration: supabase/migrations/202611010014_atomic_cancel_and_claim_refund.sql
  Applied migration: supabase/migrations/202611010015_verified_admin_refund_resolution.sql
  Applied migration: supabase/migrations/202611010016_cryptographic_ticket_token.sql

--- 2. Testing REV-REF-003 & REF-002: Attended Registration Protection ---
  PASS [1]: cancel_registration_and_claim_refund rejected attended ticket with not_refundable_attended
  PASS [2]: Attended registration status remained intact (not cancelled)
  PASS [3]: Attended QR code remained intact
  PASS [4]: Event capacity booked_count was NOT decremented for attended registration
  PASS [5]: claim_payment_refund rejected attended ticket with not_refundable_attended
  PASS [6]: cancel_registration_and_decrement returned FALSE for attended registration
  PASS [7]: admin_adopt_provider_refund rejected attended ticket with not_refundable_attended
  PASS [8]: admin_manual_settlement rejected attended ticket with not_refundable_attended

--- 3. Testing REF-001: Atomic Cancellation, Durable Claim & Exactly-Once Decrement ---
  PASS [9]: cancel_registration_and_claim_refund succeeded (ok === true)
  PASS [10]: Reported decremented_capacity === true
  PASS [11]: Registration status changed to cancelled
  PASS [12]: QR code wiped to NULL atomically
  PASS [13]: deleted_at recorded
  PASS [14]: Capacity decremented from 10 to 9
  PASS [15]: Payment refund_claim_state set to claimed
  PASS [16]: refund_reason recorded
  PASS [17]: refund_amount_due recorded
  PASS [18]: Second call rejected with already_cancelled
  PASS [19]: Capacity remained 9 (NOT decremented a second time!)

--- 4. Testing REV-REF-001: Concurrent Transactions & Global Lock Ordering (Deadlock Freedom) ---
  PASS [20]: Connection A completed without deadlock (no 40P01)
  PASS [21]: Connection B completed without deadlock (no 40P01)
  PASS [22]: Both cancellations decremented capacity safely (20 -> 18)

--- 5. Testing REV-REF-004 & REF-003: Manual Settlement Structured Evidence & Deduplication ---
  PASS [23]: Short reference number (<10 chars) rejected
  PASS [24]: Short settlement notes (<20 chars) rejected
  PASS [25]: Invalid settlement method rejected
  PASS [26]: admin_manual_settlement succeeded with valid evidence (ok === true)
  PASS [27]: Payment marked as refunded
  PASS [28]: Payment refund_status set to processed
  PASS [29]: Audit log recorded offline_manual_settlement action
  PASS [30]: Audit log preserved structured evidence with reference_number
  PASS [31]: Duplicate UTR reference reuse rejected across payments

--- 5B. Testing REV-REF-002 & REF-003: Provider Refund Adoption & Cross-Payment Deduplication ---
  PASS [32]: Malformed refund ID rejected by admin_adopt_provider_refund
  PASS [33]: admin_adopt_provider_refund succeeded for valid refund ID
  PASS [34]: Adopted payment marked refunded
  PASS [35]: Adopted payment refund_status set to processed
  PASS [36]: Adopted refund ID recorded on payment
  PASS [37]: Adopted refund archived in payment_refund_history
  PASS [38]: Cross-payment duplicate refund ID rejected

--- 6. Testing REF-004: Cryptographic CSPRNG Token & COALESCE Non-Rotation ---
  PASS [39]: confirm_payment confirmed payment successfully
  PASS [40]: Generated QR token has cluvo_ prefix
  PASS [41]: Token has 64-char SHA256 hex digest (total length 70)
  PASS [42]: Webhook replay recognized already confirmed payment (skipped)
  PASS [43]: QR code remained completely unchanged on webhook replay (zero rotation)

================================================================================
ALL PHYSICAL DATABASE CONCURRENCY & INTEGRATION TESTS PASSED: 43/43
================================================================================
```

---

## 3. Test Suite 2: Physical PostgreSQL Manual Settlement Concurrency Suite
- **Command**: `node tests/stage6_manual_settlement_test.cjs`
- **Database**: `postgres://shivapraneeth@localhost:5432/cluvo_test_stage6`
- **Result**: **45 / 45 PASSED**

```text
--- 1. Setting up Isolated Test Schema & Functions ---
Schema and Migration 202611010017 deployed successfully.

--- TEST 1: Simultaneous Confirmations of One Payout ---
  PASS [1]: Payout successfully recorded
  PASS [2]: Exactly one confirmation succeeded (successCount: 1)
  PASS [3]: Exactly one confirmation failed cleanly (failureCount: 1)
  PASS [4]: Second confirmation rejected with invalid_payout_status: Payout is no longer pending confirmation (current status: success).
  PASS [5]: Wallet balance debited exactly once: 60000 paise
  PASS [6]: Exactly 1 wallet_debited audit entry recorded

--- TEST 2: Confirmation Racing Against Dispute ---
  PASS [7]: Exactly one operation won the race (Confirm ok: true, Dispute ok: false)
  PASS [8]: Final status is consistent: success
  PASS [9]: Dispute rejected because payout was already confirmed

--- TEST 3: Admin Dispute Resolution Racing Against Organizer Action ---
  PASS [10]: Admin resolution succeeded and cancelled the payout
  PASS [11]: Organizer confirm failed on disputed/cancelled record

--- TEST 4: Sequential Duplicate Confirmation ---
  PASS [12]: First sequential confirmation succeeded
  PASS [13]: Second sequential confirmation rejected

--- TEST 5: Duplicate Settlement Submission ---
  PASS [14]: First payout submission with UTR succeeded
  PASS [15]: Duplicate UTR submission rejected with duplicate_payout_utr

--- TEST 6: Concurrent Admin Wallet Over-Allocation ---
  PASS [16]: Exactly one admin allocation succeeded (successCount: 1)
  PASS [17]: Second admin rejected with insufficient_uncommitted_balance: Requested payout amount (40000 paise) exceeds available uncommitted wallet balance (0 paise). In-flight pending and disputed payouts are reserved.

--- TEST 7: Event-Level Over-Allocation Enforcement ---
  PASS [18]: Event-level over-allocation was rejected
  PASS [19]: Correct error returned: insufficient_event_payable_balance (Requested payout amount (48000 paise) exceeds available uncommitted event balance (47000 paise). In-flight pending and disputed payouts for this event are reserved.)
  PASS [20]: Legitimate event allocation within net revenue succeeded

--- TEST 8: Legitimate Partial Payout ---
  PASS [21]: Partial event payout of 1,500 paise succeeded
  PASS [22]: Subsequent request exceeding remaining event balance rejected

--- TEST 9: Multi-Event Allocation with Single External UTR ---
  PASS [23]: First event allocation with shared UTR succeeded
  PASS [24]: Duplicate UTR on same event rejected
  PASS [25]: Second allocation with shared UTR across distinct scope succeeded

--- TEST 10: Atomic Transaction Rollback on Error ---
  PASS [26]: Payout recorded in transaction
  PASS [27]: Rolled back payout item does not exist in database
  PASS [28]: Wallet balance completely preserved after rollback

--- TEST 11: Cancelled Disputed Payout Releases Reserved Balance ---
  PASS [29]: Test 11 payout recorded successfully
  PASS [30]: Dispute filed successfully
  PASS [31]: New payout blocked while disputed settlement is active
  PASS [32]: Admin successfully cancelled disputed payout
  PASS [33]: New payout succeeded after disputed reservation was released

--- TEST 12: Admin Cancellation of Pending Payout ---
  PASS [34]: Pending payout recorded
  PASS [35]: Admin successfully cancelled pending payout
  PASS [36]: Payout status is cancelled
  PASS [37]: Cancellation reason recorded in resolution_notes

--- TEST 13: Security and Authorization Boundaries ---
  PASS [38]: Non-admin record blocked by PostgreSQL
  PASS [39]: Cross-organizer confirmation blocked

--- TEST 14: Financial Statements Query Execution (VER-MS-001) ---
  PASS [40]: Verified profiles table does not have phone column
  PASS [41]: Admin financial statement executed successfully without column error
  Admin statement returned 1 rows
  PASS [42]: Organizer financial statement executed successfully without column error
  Organizer statement returned 1 rows

--- TEST 15: RPC Parameter Signature Verification (VER-MS-002) ---
  PASS [43]: admin_cancel_manual_payout exists in pg_proc
  admin_cancel_manual_payout argument names: [p_payout_id, p_cancel_reason]
  PASS [44]: RPC signature expects p_cancel_reason (not p_cancellation_notes)
  PASS [45]: admin_cancel_manual_payout succeeds with p_cancel_reason

======================================================
ALL TESTS PASSED: 45 / 45
======================================================
```

---

## 4. Test Suite 3: Deno Database Migration Gate
- **Command**: `deno test -A supabase/tests/migration_gate.test.ts`
- **Result**: **31 / 31 PASSED**

```text
running 31 tests from ./supabase/tests/migration_gate.test.ts
migration version prefixes are unique and ordered ... ok (815µs)
202611010014 atomic cancel and attended refund guard shipped ... ok (154µs)
202611010015 verified admin refund resolution shipped ... ok (81µs)
202611010016 cryptographic ticket token shipped ... ok (49µs)
202611010017 concurrency-safe manual settlements, dispute resolution, and event limits shipped ... ok (120µs)
202611010012 owner_self_delete_guard prevents owners from orphaning community ... ok (393µs)
202611010013 owner_self_delete_restrictive_guard enforces restrictive owner protection ... ok (286µs)
202611010002 fix_webhook_processed_at fixes column name to processed_at ... ok (212µs)
202611010003 manual_payout_deduplication creates scoped partial unique index and RPC duplicate check ... ok (222µs)
202611010004 fix_booking_hold_reuse hoists hold reuse check outside payments lookup ... ok (222µs)
202611010001 incoming_payment_remediation defines capacity holds, atomic webhook confirmation, and unique index ... ok (294µs)
011 adds both grace columns, the index, and the grant ... ok (14µs)
claim_due_deletions is locked, search_path-safe, and service_role only ... ok (12µs)
012 confirm_payment keeps both the cancelled-registration and NULL-user guards ... ok (13µs)
013 adds the JSONB scrub index and payment lookup index ... ok (16µs)
015 schedules the purge via Vault, never a hardcoded URL ... ok (16µs)
016 retains reports and unlinks the reporter ... ok (11µs)
014 outbox is deny-all for clients and service_role-writable ... ok (31µs)
202610290003 confirm_payment sets refund_reason without blocking refund_status ... ok (15µs)
202610300002 check_in_registration has row lock, atomic conditional update, and service_role grant ... ok (15µs)
202610300003 admin_financial_ledger_and_payouts deploys passbook RPC and manual payout RPCs ... ok (16µs)
202610300004 admin_communities_dropdown deploys get_admin_communities RPC ... ok (11µs)
202610300005 admin_profiles_rpc_and_fix_ledger fixes attendee_phone and deploys get_admin_profiles RPC ... ok (44µs)
202610300006 organizer_financial_statement_and_dispute deploys organizer RPCs ... ok (12µs)
202610300007 community_applications_and_approval_flow deploys staging table and approval RPCs ... ok (13µs)
202610300009 payment_and_registration_index_optimizations adds safe non-concurrent indexes ... ok (329µs)
202611010005 fix_financial_statement_refund_debits dedupes by provider refund id and enforces cumulative share cap ... ok (312µs)
202611010006 financial_reconciliation_engine provides strictly read-only 3-way reconciliation, KPIs, and concurrency-safe payout locking ... ok (409µs)
202611010007 fix_admin_financial_statement_phone replaces prof.phone with NULL::TEXT ... ok (227µs)
202611010008 decommission_cashfree_cron unschedules payout-status-sync ... ok (186µs)
202611010009 event_capacity_and_status_guard enforces checks and trigger without rewriting historical counts ... ok (175µs)

ok | 31 passed | 0 failed (7ms)
```

---

## 5. Test Suite 4: Deno Refund Remediation & Razorpay Provider Gate
- **Command**: `deno test -A supabase/tests/stage6_refund_remediation.test.ts`
- **Result**: **8 / 8 PASSED**

```text
running 8 tests from ./supabase/tests/stage6_refund_remediation.test.ts
REF-001 / REV-REF-001: cancel_registration_and_claim_refund coordinates cancellation and claim atomically with Level 1 -> Level 2 -> Level 3 lock ordering ... ok (534µs)
REF-001: issue-refund edge function invokes cancel_registration_and_claim_refund atomically ... ok (332µs)
REF-002: claim_payment_refund enforces attended check and strict Level 2 -> Level 3 lock ordering ... ok (95µs)
REV-REF-002: admin-adopt-refund Edge Function validates admin privileges and verifies Razorpay provider status ... ok (473µs)
REF-003 / REV-REF-003: admin_adopt_provider_refund validates attended status, format, uniqueness, and ledger idempotency ... ok (189µs)
REF-003 / REV-REF-003: admin_manual_settlement validates attended status, structured evidence, and prevents duplicate reference numbers ... ok (101µs)
REF-004: confirm_payment generates 244-bit CSPRNG token and never rotates on duplicate webhook ... ok (78µs)
REF-005: Mobile client registers /refunds/:id and isolates historical refund receipts ... ok (723µs)

ok | 8 passed | 0 failed (4ms)
```

---

## 6. Test Suite 5: Admin Web Frontend Suite
- **Command**: `npm --prefix apps/admin-web test -- --run`
- **Result**: **40 / 40 PASSED (6 Test Files)**

```text
 ✓ src/components/AdminLayout.test.tsx (5 tests) 154ms
 ✓ src/Auth.test.tsx (5 tests) 198ms
 ✓ src/pages/FinancialsPage.test.tsx (6 tests) 564ms
 ✓ src/components/ManualPayoutModal.test.tsx (8 tests) 655ms
 ✓ src/components/PayoutDisputeResolutionModal.test.tsx (7 tests) 750ms
 ✓ src/components/RefundManualReviewModal.test.tsx (9 tests) 782ms

 Test Files  6 passed (6)
      Tests  40 passed (40)
   Start at  02:39:30
   Duration  1.78s
```

---

## 7. Test Suite 6: Organizer Web Frontend Suite
- **Command**: `npm --prefix apps/organizer-web test -- --run`
- **Result**: **26 / 26 PASSED (6 Test Files)**

```text
 ✓ src/components/protected-route.test.tsx (6 tests) 137ms
 ✓ src/components/media/media-section.test.tsx (3 tests) 128ms
 ✓ src/components/events/cancel-event.test.tsx (3 tests) 185ms
 ✓ src/components/check-in/check-in.test.tsx (3 tests) 235ms
 ✓ src/components/events/event-form.test.tsx (5 tests) 258ms
 ✓ src/components/payout/payout-section.test.tsx (6 tests) 700ms

 Test Files  6 passed (6)
      Tests  26 passed (26)
   Start at  02:39:36
   Duration  1.49s
```

---

## 8. Test Suite 7: Flutter Mobile Client Suite
- **Command**: `(cd apps/mobile && flutter test test/refund_detail_navigation_test.dart)`
- **Result**: **3 / 3 PASSED**

```text
00:01 +0: REF-005 ... requires either paymentId or historyId
00:01 +1: REF-005 ... app.dart registers /refunds/:id and /payments/:id routes
00:01 +2: REF-005 ... routes to /refunds for archived refunds
00:01 +3: All tests passed!
```

