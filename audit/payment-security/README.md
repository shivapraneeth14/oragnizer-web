# CLUVO MASTER FORENSIC ENGINEERING AUDIT
## Payments, Refunds, Wallet, Ledger, Flutter, Organizer Web, Supabase, Razorpay, Security & Regression Prevention

## Objective
Act as principal fintech architect, senior payment reliability engineer, PostgreSQL/Supabase security auditor, Razorpay integration specialist, and adversarial QA engineer to conduct a complete, evidence-based audit of the Cluvo platform.

**Mission:** Determine whether any customer or organizer can lose money, receive incorrect amounts, experience missing/duplicated refunds, see incorrect wallet balances, or encounter broken booking, ticketing, or settlement behavior.

## Primary Objectives
1. **Protect customer and organizer funds** - Identify all financial loss scenarios
2. **Verify correct accounting** - Ensure every payment, booking, cancellation, refund, wallet movement, and settlement is correctly linked and accounted for
3. **Identify defects** - Find actual defects and credible failure paths before they affect users
4. **Verify authorization controls** - Confirm organizer authorization prevents cross-organizer ticket scanning
5. **Cross-check systems** - Examine all applications, database logic, and gateway interactions
6. **Prevent regression** - Ensure existing valid functionality doesn't break during future fixes
7. **Preserve findings** - Maintain all findings and evidence across Claude Code sessions

## Initial Operating Mode
**READ-ONLY AUDIT** - Do not modify application code, apply migrations, mutate production data, deploy functions, change production configuration, or initiate real payments/refunds.

Complete investigation and remediation plan before requesting approval for changes.

## Audit Structure
Phased investigation with token-efficient evidence collection:

### Phase 0: ARCHITECTURE AND DEPENDENCY MAPPING
- Map complete transaction architecture across all systems
- Identify authoritative source of truth for financial data
- Deliver architecture map and component inventory

### Phase 1: PAYMENT LIFECYCLE AND STATE MACHINE
- Trace complete lifecycle: Booking → Order → Payment → Verification → Confirmation → Tickets → Cancellation → Refund → Wallet/Ledger → Settlement
- Verify payment-booking linking, webhook handling, idempotency, and transaction boundaries
- Document state machine, permitted transitions, and enforcement mechanisms

### Phase 2: CRITICAL REBOOKING AND REPEATED REFUND SCENARIO
- Investigate booking A → refund A → booking B → refund B sequence
- Prove booking B uses independent payment lifecycle
- Identify stale identifiers, faulty joins, and duplicate-registration issues

### Phase 3: CUSTOMER CANCELLATION POLICY
- Verify 24-hour cancellation rule enforcement across all systems
- Test boundary conditions and concurrent cancellation scenarios
- Identify discrepancies between stated policy and implementation

### Phase 4: ORGANIZER EVENT CANCELLATION AND REFUND FAILURE
- Investigate organizer-triggered refund failures
- Trace flow from organizer interface through backend to gateway
- Determine root cause of observed failures

### Phase 5: RAZORPAY AND REFUND RELIABILITY
- Separate refund states: eligible, due, initiated, submitted, pending, failed, unknown, confirmed
- Verify local status changes don't falsely establish financial outcomes
- Handle gateway timeouts and missing internal records

### Phase 6: ORGANIZER WALLET, LEDGER AND SETTLEMENTS
- Trace organizer earnings and payable balance calculations
- Cross-check payment, refund, fee, and payout processing
- Identify double-counts, missing reversals, and incorrect balances

### Phase 7: CROSS-SYSTEM FINANCIAL RECONCILIATION
- Independently verify financial data across all sources
- Establish critical invariants (payments map to bookings, refunds map to payments, etc.)
- Identify discrepancies and contradictions

### Phase 8: FLUTTER CUSTOMER APPLICATION AUDIT
- Inspect Flutter source code for payment, booking, cancellation, refund handling
- Verify customers see correct booking/payment status
- Trace Flutter operations to backend implementations

### Phase 9: ORGANIZER AND ADMIN WEB AUDIT
- Inspect React organizer and admin source code
- Verify financial operation behavior and error handling
- Ensure consistency with Flutter and database state

### Phase 10: CROSS-ORGANIZER TICKET-SCANNING SECURITY
- Determine if organizer A can scan organizer B's tickets
- Verify server-side authorization checks
- Test unauthorized access scenarios

### Phase 11: PAYMENT HISTORY AND TIMESTAMPS
- Audit transaction history data and presentation
- Verify correct timestamps for all events
- Ensure repeat bookings remain distinct

### Phase 12: REGRESSION AND BREAKAGE PREVENTION
- Identify what could break if defects are fixed
- Assess impacts on dependent functions and systems
- Document migration, deployment, and rollback considerations

### Phase 13: TEST MATRIX
- Inspect existing tests and create additional ones
- Cover minimum required scenarios
- Use safe local tests and Razorpay sandbox tests

## File Organization
All audit artifacts maintained in `/Users/shivapraneeth/Documents/community/audit/payment-security/`:

- `README.md` - Objectives, architecture, risks, current phase
- `SCOPE.md` - Repository inventory, relevant files, coverage
- `PROGRESS.md` - Task status, evidence, remaining work
- `FINDINGS.md` - Findings register with IDs, severity, evidence
- `EVIDENCE.md` - Source paths, line ranges, test outputs
- `TEST-MATRIX.md` - Scenarios, expected/actual outcomes
- `CROSSCHECK.md` - Cross-system consistency checks
- `RECONCILIATION.md` - Financial invariants, discrepancy checks
- `REGRESSION.md` - Dependencies, risks, regression coverage
- `FINAL-REPORT.md` - Executive summary and remediation plan
- `HANDOFF.md` - Checkpoint for continuing in fresh session

## Findings Standard
- **Stable IDs:** PAY-001, REF-001, WAL-001, AUTH-001, FLUTTER-001, REG-001
- **Severity:** CRITICAL, HIGH, MEDIUM, LOW, INFORMATIONAL
- **Classification:** CONFIRMED DEFECT, POTENTIAL RISK, VERIFIED SAFE, NOT VERIFIABLE
- **Evidence:** Exact source files, line ranges, database objects

## Execution Directives
- Start with Phase 0
- Prioritize financial loss and authorization bypasses
- Record evidence as you work
- Update artifacts at end of each phase
- Do not claim complete coverage while critical flows remain uninspected
- Preserve append-only financial history
- No real payments/refunds performed

## Final Objective
Establish with evidence that all financial operations behave correctly across Flutter, React, Supabase, and Razorpay, identifying every credible financial-loss path and preventing regression.

**Audit first. Record everything important. Cross-check independently. Do not implement changes until explicitly approved.**

## Current checkpoint (2026-10-30)
Repository access is verified and direct source reads are succeeding. This audit is incomplete; no application code, migrations, data, production configuration, payments, or refunds were modified or initiated. See `SCOPE.md`, `PROGRESS.md`, `FINDINGS.md`, and `HANDOFF.md` for the evidence-backed checkpoint.

The delegated-agent tool was unavailable due to an upstream `HTTP 400 Unsupported parameter: temperature`; no agent output was treated as evidence. All current evidence was obtained through successful direct reads in this session.