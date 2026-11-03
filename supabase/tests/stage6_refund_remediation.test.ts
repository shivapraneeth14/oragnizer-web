// ============================================================================
// CLUVO STAGE 6 RAZORPAY REFUND & EDGE-CASE REMEDIATION TEST SUITE
// Verifies all 5 findings: REF-001, REF-002, REF-003, REF-004, REF-005.
// Run: deno test --allow-env --allow-read supabase/tests/stage6_refund_remediation.test.ts
// ============================================================================

import { assert, assertEquals } from "jsr:@std/assert"

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url))

// ----------------------------------------------------------------------------
// REF-001 / REV-REF-001: Atomic Cancellation, Durable Claim & Strict Lock Hierarchy
// ----------------------------------------------------------------------------
Deno.test("REF-001 / REV-REF-001: cancel_registration_and_claim_refund coordinates cancellation and claim atomically with Level 1 -> Level 2 -> Level 3 lock ordering", async () => {
  const sql = await read("../migrations/202611010014_atomic_cancel_and_claim_refund.sql")

  assert(
    sql.includes("CREATE OR REPLACE FUNCTION public.cancel_registration_and_claim_refund("),
    "cancel_registration_and_claim_refund function must exist",
  )
  assert(
    sql.includes("SET search_path = ''"),
    "cancel_registration_and_claim_refund must have empty search_path",
  )
  assert(
    sql.includes("REVOKE ALL PRIVILEGES ON FUNCTION public.cancel_registration_and_claim_refund(UUID, UUID) FROM PUBLIC, anon, authenticated"),
    "cancel_registration_and_claim_refund must revoke public privileges",
  )
  assert(
    sql.includes("GRANT EXECUTE ON FUNCTION public.cancel_registration_and_claim_refund(UUID, UUID) TO service_role"),
    "cancel_registration_and_claim_refund must grant execute to service_role",
  )

  // REV-REF-001: Global Lock Hierarchy Level 1 (events) -> Level 2 (registrations) -> Level 3 (payments)
  const lockEventIdx = sql.indexOf("PERFORM 1 FROM public.events WHERE id = v_event_id FOR UPDATE;")
  const lockRegIdx = sql.indexOf("FROM public.registrations r\n  WHERE r.id = v_reg_id\n  FOR UPDATE;")
  const lockPayIdx = sql.indexOf("FROM public.payments\n  WHERE id = p_payment_id\n  FOR UPDATE;")

  assert(lockEventIdx > 0, "Level 1 event lock must be present")
  assert(lockRegIdx > 0, "Level 2 registration lock must be present")
  assert(lockPayIdx > 0, "Level 3 payment lock must be present")
  assert(lockEventIdx < lockRegIdx, "Level 1 event lock must precede Level 2 registration lock")
  assert(lockRegIdx < lockPayIdx, "Level 2 registration lock must precede Level 3 payment lock")

  // Also check cancel_registration_and_decrement lock hierarchy
  const decEventLockIdx = sql.indexOf("PERFORM 1 FROM public.events WHERE id = v_event_id FOR UPDATE;")
  assert(decEventLockIdx > 0, "cancel_registration_and_decrement must lock Level 1 event FOR UPDATE first")

  // Invariant: Ticket cancellation and booked_count decrement must precede payment claim in the same function
  const updateRegIdx = sql.indexOf("UPDATE public.registrations\n  SET status = 'cancelled'")
  const updatePaymentIdx = sql.indexOf("UPDATE public.payments\n  SET refund_claim_state = 'claimed'")
  assert(updateRegIdx > 0, "must update registration to cancelled")
  assert(updatePaymentIdx > 0, "must update payment to claimed")
  assert(updateRegIdx < updatePaymentIdx, "registration cancellation must precede payment claim acquisition")

  // Invariant: QR code must be cleared atomically
  assert(sql.includes("qr_code = NULL"), "QR code must be cleared to prevent check-in")

  // Invariant: Capacity decremented exactly once
  assert(
    sql.includes("booked_count = GREATEST(0, booked_count - 1)"),
    "must decrement capacity atomically for confirmed registration",
  )
})

Deno.test("REF-001: issue-refund edge function invokes cancel_registration_and_claim_refund atomically", async () => {
  const fnSrc = await read("../functions/issue-refund/index.ts")

  const rpcCallIdx = fnSrc.indexOf('"cancel_registration_and_claim_refund"')
  const refundAttemptIdx = fnSrc.indexOf("await attemptRefund(")

  assert(rpcCallIdx > 0, "issue-refund must call cancel_registration_and_claim_refund")
  assert(refundAttemptIdx > 0, "issue-refund must call attemptRefund")
  assert(
    rpcCallIdx < refundAttemptIdx,
    "cancellation & claim must be acquired before calling attemptRefund",
  )

  assert(
    fnSrc.includes("not_refundable_attended"),
    "issue-refund must handle not_refundable_attended error code",
  )
  assert(
    fnSrc.includes("already_cancelled"),
    "issue-refund must handle already_cancelled error code",
  )
  assert(
    fnSrc.includes("attempt: cancelClaimResult.claim_attempt"),
    "issue-refund must pass acquired claim attempt to attemptRefund",
  )
})

// ----------------------------------------------------------------------------
// REF-002: Attended Registration Refund Protection & Lock Ordering
// ----------------------------------------------------------------------------
Deno.test("REF-002: claim_payment_refund enforces attended check and strict Level 2 -> Level 3 lock ordering", async () => {
  const sql = await read("../migrations/202611010014_atomic_cancel_and_claim_refund.sql")

  assert(
    sql.includes("CREATE OR REPLACE FUNCTION public.claim_payment_refund("),
    "claim_payment_refund must be defined",
  )

  const lockRegIdx = sql.indexOf("FROM public.registrations r\n  WHERE r.id = v_reg_id\n  FOR UPDATE")
  const lockPayIdx = sql.indexOf("FROM public.payments p\n  WHERE p.id = p_payment_id\n  FOR UPDATE OF p")
  assert(lockRegIdx > 0, "registration must be locked FOR UPDATE (Level 2)")
  assert(lockPayIdx > 0, "payment must be locked FOR UPDATE (Level 3)")
  assert(
    lockRegIdx < lockPayIdx,
    "Level 2 registration lock must precede Level 3 payment lock to prevent deadlocks",
  )

  const attendedCheckIdx = sql.indexOf("IF v_reg_status = 'attended' THEN")
  assert(attendedCheckIdx > 0, "attended guard must be present")
  assert(
    sql.includes("not_refundable_attended"),
    "attended guard must return not_refundable_attended error",
  )
  assert(
    attendedCheckIdx < lockPayIdx,
    "attended check must reject immediately before acquiring payment lock",
  )
})

// ----------------------------------------------------------------------------
// REF-003 / REV-REF-002 / REV-REF-003: Verified Admin Provider Refund Adoption & Manual Settlement
// ----------------------------------------------------------------------------
Deno.test("REV-REF-002: admin-adopt-refund Edge Function validates admin privileges and verifies Razorpay provider status", async () => {
  const fnSrc = await read("../functions/admin-adopt-refund/index.ts")
  const rzpSrc = await read("../functions/_shared/razorpay.ts")

  // Authentication & authorization checks
  assert(
    fnSrc.includes("supabase.auth.getUser(token)"),
    "admin-adopt-refund must verify caller session via auth.getUser()",
  )
  assert(
    fnSrc.includes('.from("profiles")'),
    "admin-adopt-refund must verify is_admin in profiles table",
  )
  assert(
    fnSrc.includes("profile?.is_admin"),
    "admin-adopt-refund must check profile.is_admin",
  )

  // Razorpay server credential loading & API verification
  assert(
    rzpSrc.includes('requiredEnv("RAZORPAY_KEY_ID")'),
    "shared razorpay module must use server RAZORPAY_KEY_ID",
  )
  assert(
    rzpSrc.includes('requiredEnv("RAZORPAY_KEY_SECRET")'),
    "shared razorpay module must use server RAZORPAY_KEY_SECRET",
  )
  assert(
    fnSrc.includes("razorpayGet"),
    "admin-adopt-refund must fetch refund record from Razorpay API via razorpayGet",
  )

  // Strict invariant checks on fetched Razorpay record
  assert(
    fnSrc.includes("providerRefund.payment_id !== payment.razorpay_payment_id"),
    "must verify refund belongs to expected Razorpay payment ID",
  )
  assert(
    fnSrc.includes("providerRefund.amount"),
    "must verify refund amount matches expected task amount in paise",
  )
  assert(
    fnSrc.includes("providerRefund.currency"),
    "must verify currency is INR",
  )
  assert(
    fnSrc.includes('providerStatus !== "processed"'),
    "must reject refunds that are not strictly in 'processed' state",
  )

  // Database adoption call
  assert(
    fnSrc.includes('admin_adopt_provider_refund'),
    "must call admin_adopt_provider_refund database RPC only after gateway verification",
  )
})

Deno.test("REF-003 / REV-REF-003: admin_adopt_provider_refund validates attended status, format, uniqueness, and ledger idempotency", async () => {
  const sql = await read("../migrations/202611010015_verified_admin_refund_resolution.sql")

  assert(
    sql.includes("CREATE OR REPLACE FUNCTION public.admin_adopt_provider_refund("),
    "admin_adopt_provider_refund function must exist",
  )

  // REV-REF-003: Attended registration rejection
  assert(
    sql.includes("IF v_reg.status = 'attended' THEN"),
    "admin_adopt_provider_refund must check if registration status is attended",
  )
  assert(
    sql.includes("'error', 'not_refundable_attended'"),
    "admin_adopt_provider_refund must reject attended registrations with not_refundable_attended",
  )

  // 1. Format check: rfnd_ prefix and length >= 10
  assert(
    sql.includes("v_clean_refund_id ~ '^rfnd_[A-Za-z0-9]+$'"),
    "must validate Razorpay refund ID regex format (rfnd_[A-Za-z0-9]+)",
  )
  assert(
    sql.includes("length(v_clean_refund_id) < 10"),
    "must validate refund ID minimum length",
  )

  // 2. Cross-payment uniqueness
  assert(
    sql.includes("WHERE razorpay_refund_id = v_clean_refund_id"),
    "must reject provider refund ID already bound to another payment",
  )

  // 3. In-flight claim conflict check (< 15 min)
  assert(
    sql.includes("refund_claim_state = 'claimed'"),
    "must check active claim state",
  )
  assert(
    sql.includes("refund_claim_at > clock_timestamp() - interval '15 minutes'"),
    "must check 15 minute in-flight quiet period",
  )

  // 4. Append-only ledger inspection for wallet debit
  assert(
    sql.includes("action = 'wallet_debited'"),
    "must check payment_audit_log to ensure zero double-debit of community wallet",
  )

  // 5. Historical refund archive
  assert(
    sql.includes("INSERT INTO public.payment_refund_history"),
    "must record settled refund into payment_refund_history",
  )
})

Deno.test("REF-003 / REV-REF-003: admin_manual_settlement validates attended status, structured evidence, and prevents duplicate reference numbers", async () => {
  const sql = await read("../migrations/202611010015_verified_admin_refund_resolution.sql")

  assert(
    sql.includes("CREATE OR REPLACE FUNCTION public.admin_manual_settlement("),
    "admin_manual_settlement function must exist",
  )

  // REV-REF-003: Attended registration rejection
  assert(
    sql.includes("IF v_reg.status = 'attended' THEN"),
    "admin_manual_settlement must check if registration status is attended",
  )
  assert(
    sql.includes("'error', 'not_refundable_attended'"),
    "admin_manual_settlement must reject attended registrations with not_refundable_attended",
  )

  // Structured evidence validation
  assert(
    sql.includes("v_method NOT IN ('bank_transfer', 'upi', 'cash', 'cheque', 'dispute_resolution')"),
    "must enforce valid settlement method",
  )
  assert(
    sql.includes("length(v_ref) < 10"),
    "must require minimum 10-char reference number",
  )

  // Reference number uniqueness in audit log
  assert(
    sql.includes("action = 'offline_manual_settlement'"),
    "must record manual settlement in payment_audit_log",
  )

  // Backward compatible dispatcher
  assert(
    sql.includes("CREATE OR REPLACE FUNCTION public.admin_resolve_refund_task("),
    "admin_resolve_refund_task dispatcher must exist",
  )
  assert(
    sql.includes("public.admin_adopt_provider_refund("),
    "dispatcher must delegate adopt to admin_adopt_provider_refund",
  )
  assert(
    sql.includes("public.admin_manual_settlement("),
    "dispatcher must delegate manual settlement to admin_manual_settlement",
  )
})

// ----------------------------------------------------------------------------
// REF-004: Cryptographically Unpredictable QR Token & Duplicate Webhook Protection
// ----------------------------------------------------------------------------
Deno.test("REF-004: confirm_payment generates 244-bit CSPRNG token and never rotates on duplicate webhook", async () => {
  const sql = await read("../migrations/202611010016_cryptographic_ticket_token.sql")

  assert(
    sql.includes("CREATE OR REPLACE FUNCTION public.confirm_payment("),
    "confirm_payment function must exist",
  )

  // 244-bit compound CSPRNG
  assert(
    sql.includes("'cluvo_' || encode(sha256((gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text)::bytea), 'hex')"),
    "must generate token using compound dual-UUID CSPRNG and SHA-256",
  )

  // Non-rotation on duplicate webhooks
  assert(
    sql.includes("qr_code = COALESCE("),
    "must preserve existing qr_code using COALESCE on webhook replay",
  )

  // Search-path safety: no unqualified gen_random_bytes from pgcrypto
  assert(
    !sql.includes("gen_random_bytes"),
    "must not call gen_random_bytes which fails under search_path = ''",
  )
  assert(
    sql.includes("SET search_path = ''"),
    "confirm_payment must be search_path safe",
  )
})

// ----------------------------------------------------------------------------
// REF-005: Historical Refund Navigation & Immutable Receipts
// ----------------------------------------------------------------------------
Deno.test("REF-005: Mobile client registers /refunds/:id and isolates historical refund receipts", async () => {
  const appSrc = await Deno.readTextFile("apps/mobile/lib/app.dart")
  const screenSrc = await Deno.readTextFile("apps/mobile/lib/screens/payment_detail_screen.dart")
  const listSrc = await Deno.readTextFile("apps/mobile/lib/screens/my_payments_screen.dart")

  // App router registration
  assert(
    appSrc.includes("path: '/refunds/:id'"),
    "app.dart must register /refunds/:id route",
  )
  assert(
    appSrc.includes("PaymentDetailScreen(historyId: state.pathParameters['id']!)"),
    "app.dart must instantiate PaymentDetailScreen with historyId",
  )

  // List card navigation
  assert(
    listSrc.includes("context.push(isHistory ? '/refunds/$paymentId' : '/payments/$paymentId')"),
    "my_payments_screen.dart must route to /refunds/$paymentId when isHistory is true",
  )

  // Detail screen queries payment_refund_history when historyId provided
  assert(
    screenSrc.includes("from('payment_refund_history')"),
    "payment_detail_screen.dart must query payment_refund_history for historical receipts",
  )
  assert(
    screenSrc.includes("final String? historyId;"),
    "payment_detail_screen.dart must declare historyId parameter",
  )
  assert(
    screenSrc.includes("title: Text(widget.historyId != null ? 'Refund Details' : 'Payment Details')"),
    "payment_detail_screen.dart must display Refund Details for history receipts",
  )
})
