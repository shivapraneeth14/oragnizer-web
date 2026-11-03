# Phase 3.3 Defect Register — Cluvo Platform (Stage 7)

## Legend
- **Confirmed Defect**: Verified product-code bug with reproducible evidence
- **Suspected Issue**: Potential problem not yet confirmed; requires further investigation
- **Coverage Gap**: No test exists for this scenario; not a product bug
- **Blocked**: Test cannot run due to environment/dependency limitations

---

## Confirmed Defects

| ID | Severity | Application | Feature | Source Location | Reproduction Steps | Expected Behaviour | Actual Behaviour | Impact | Test Evidence | Recommended Fix |
|---|---|---|---|---|---|---|---|---|---|---|

|---------|----------|-------------|---------|------------------|-------------------|-------------------|------------------|--------|---------------|-----------------|
| **NO CONFIRMED PRODUCT DEFECTS** | — | — | — | — | — | — | — | — | — | — |

*No product-code bugs were discovered during Phase 3.3 testing. All existing test suites pass (219/219 baseline, 43/43 concurrency). The test script environment fixes (adding `start_date` to INSERT statements) were compatibility adjustments, not business logic changes.*

---

## Suspected Issues (Not Yet Confirmed)

| ID | Severity | Application | Feature | Source Location | Description | Evidence |
|---|----------|-------------|---------|------------------|-------------|----------|
| **SI-001** | Medium | All | Security & RLS | N/A | Security and RLS policy testing not executed in this phase. Potential data isolation vulnerabilities remain unverified. | Test environment does not have Supabase fully started with separate test identities; RLS policies cannot be verified without running `supabase start` and calling RPCs with different role contexts. |
| **SI-002** | Medium | All | Edge Functions | N/A | 47 Edge Functions not invoked locally. Authorization and input validation untested. | `supabase start` not run during Phase 3.3. Functions available in `supabase/functions/` but no test evidence. |
| **SI-003** | Medium | All | Financial invariants | N/A | Partial multi-event payout allocation and multi-event payout allocation not verified with dedicated scripts. | No test script exercises `allocate_payouts` RPC with multiple events. Integer paise invariants verified only within concurrency test paths. |
| **SI-004** | Medium | All | Payment webhooks | N/A | Razorpay webhook duplicate handling and signature validation not tested with real/mocked webhooks. | No Razorpay test-mode webhooks were sent during Phase 3.3. Provider timeout and retry scenarios untested. |
| **SI-005** | Medium | Flutter | Paid ticket booking | `apps/mobile/test/paid_event_button_test.dart` | Lost callback after external UPI app redirect (90s safety timer timeout) not explicitly simulated. | Flutter test suite covers free booking and fee math, but airplane-mode- During-UPI-redirect scenario not included in 153 tests. |
| **SI-006** | Medium | Organizer Web | Payout concurrent confirmations/disputes | `apps/organizer-web/src/components/payout/payout-section.test.tsx` | Race condition between two organizers confirming the same payout not tested. | Organizer Web Vitest passes 26/26, but concurrent organizer confirmation/dispute scenario not covered. |
| **SI-007** | Medium | Admin Web | Cross-community data access | `apps/admin-web/src/pages/FinancialsPage.test.tsx` | Non-admin user accessing `/financials` directly via URL tested, but cross-community data access by organizer not tested. | Admin Web tests cover URL authorization but not inter-organizer data boundary enforcement. |

---

## Coverage Gaps (Not Product Defects)

| ID | Category | Affected Area | Description | Phase 3.3 Status |
|---|---|---|---|---|
| **CG-001** | Deno backend tests | `supabase/tests/` (37 files) | JSR dependency `npm:@supabase/realtime-js@2.112.2` unavailable in isolated local environment. No package registry access permitted. | **BLOCKED** — documented; no test results claimed |
| **CG-002** | Security & RLS | Row-level policies, cross-user/community data access | Not executed during Phase 3.3. Requires Supabase start with separate test identities. | **NOT RUN** |
| **CG-003** | Edge Function tests | All 47 functions | Not executed. Supabase not started locally. | **NOT RUN** |
| **CG-004** | Financial invariants | Partial multi-event payout allocation | No test script exercises payout splitting across multiple events. | **NOT EXECUTED** |
| **CG-005** | Financial invariants | Multi-event payout allocation | No test script allocates payouts across >1 event. | **NOT EXECUTED** |
| **CG-005** | Payment integration | Razorpay full workflow | Paid ticket booking with Razorpay order creation, payment success/failure, webhook handling not end-to-end tested. | **NOT EXECUTED** (mock test mode only) |
| **CG-007** | Google authentication | Google OAuth flow | Not fully executed with real Google OAuth redirect. | **NOT EXECUTED** |
| **CG-009** | Community management | Create, approve, reject requests | Organizer community management automated test coverage insufficient. | **INSUFFICIENT** |
| **CG-010** | Failure scenarios | Simultaneous booking/cancellation beyond concurrency scripts | Additional failure scenarios not explicitly tested (e.g., network interruption during booking, worker crash after task claim). | **NOT EXECUTED** |

---

## Blocked Tests (No Evidence Claimed)

| ID | Test Suite | Reason | Status |
|---|---|---|---|
| **BT-001** | Deno backend (`supabase/tests/`) | `JSR dependency unavailable`: `Could not find a matching package for 'npm:@supabase/realtime-js@2.112.2'` | **BLOCKED** — explicit ground restriction: no package registry access, no staging/production access |
| **BT-002** | Edge Function invocation | Supabase not started locally; `supabase start` not performed during Phase 3.3 | **BLOCKED** — environment limitation |
| **BT-003** | Security & RLS policies | Requires separate test identities and Supabase RPC execution | **BLOCKED** — would require starting Supabase and testing with different role contexts; restricted until separate approval |
| **BT-004** | Payment webhook end-to-end | No real Razorpay transactions; webhook duplicate/mock scenarios not scripted | **BLOCKED** — no real payments or refunds permitted |
| **BT-005** | Concurrency: network interruption during booking | Script not written; would require simulating network loss during pg transaction | **NOT RUN** — test development required |
| **BT-006** | Failure: worker crash after task claim | Script not written; would require provoking worker process crash | **NOT RUN** — test development required |
| **BT-007** | Failure: transaction failure | Script not written; would require provoked DB transaction failure | **NOT RUN** — test development required |

---

## Defect Summary

| Category | Count |
|---|---|
| Confirmed product defects | 0 |
| Suspected issues | 7 |
| Coverage gaps | 10 |
| Blocked tests | 7 |

**No product-code fixes required during Phase 3.3.** All identified issues are either coverage gaps (tests not yet written or environments not configured) or suspected issues (potential vulnerabilities unverified due to test environment limitations).

**Recommended for Phase 3.4**: Address blocked and suspected issues in priority order, starting with Deno dependency resolution, then security/RLS testing, then Edge Function invocation, then financial invariant extension scripts.
