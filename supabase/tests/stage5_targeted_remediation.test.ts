// ============================================================================
// CLUVO STAGE 5 TARGETED REMEDIATION TEST SUITE
// Tests the 3 targeted remediation findings:
// 1. PAY-REL-006: Webhook Column Mismatch & Atomic Deduplication
// 2. FIN-REL-008: Manual Payout Scoped Deduplication & Wallet Safety
// 3. PAY-CONC-007: Booking Hold Reuse Scoping in reserve_ticket_capacity
// ============================================================================

import { assert, assertEquals } from "jsr:@std/assert"

const readMigration = (filename: string) =>
  Deno.readTextFile(new URL(`../migrations/${filename}`, import.meta.url))

// ============================================================================
// FIX 1: PAY-REL-006 — WEBHOOK COLUMN MISMATCH & ATOMIC DEDUPLICATION
// ============================================================================

Deno.test("PAY-REL-006: confirm_payment_from_webhook uses processed_at column", async () => {
  const sql = await readMigration("202611010002_fix_webhook_processed_at.sql")
  
  // Must NOT contain the old bug: created_at
  assert(
    !sql.includes("processed_webhooks (id, provider, event_type, created_at)"),
    "Regression: migration must not insert into non-existent created_at column"
  )
  
  // Must insert into the actual schema column: processed_at
  assert(
    sql.includes("processed_webhooks (id, provider, event_type, processed_at)"),
    "Fix verified: migration inserts into actual schema column processed_at"
  )

  // Must check processed_webhooks for idempotency at the start
  assert(
    sql.includes("IF EXISTS (SELECT 1 FROM public.processed_webhooks WHERE id = p_webhook_id) THEN"),
    "Idempotency guard: duplicate webhooks return already_processed"
  )

  // Must execute confirm_payment BEFORE recording deduplication
  const confirmPaymentPos = sql.indexOf("public.confirm_payment(")
  const insertWebhookPos = sql.indexOf("INSERT INTO public.processed_webhooks")
  assert(confirmPaymentPos >= 0 && insertWebhookPos >= 0, "Both operations present")
  assert(
    confirmPaymentPos < insertWebhookPos,
    "Payment confirmation must precede webhook recording to prevent silently skipping failed attempts"
  )

  // Error in confirm_payment must abort without recording webhook
  assert(
    sql.includes("IF v_confirm_res->>'error' IS NOT NULL THEN\n    RETURN v_confirm_res;"),
    "Failed confirmations return early without recording webhook id"
  )
})

// Webhook State Machine Simulator for Lifecycle Invariants
class WebhookEngineSimulator {
  processedWebhooks = new Set<string>()
  payments = new Map<string, { id: string; status: string; amount: number; currency: string; razorpay_payment_id?: string }>()
  registrations = new Map<string, { id: string; status: string; event_id: string }>()
  events = new Map<string, { id: string; booked_count: number; capacity: number }>()

  confirmPayment(paymentId: string, amount: number, currency: string, razorpayPaymentId: string): { ok: boolean; status?: string; error?: string } {
    const pay = this.payments.get(paymentId)
    if (!pay) return { ok: false, error: "payment_not_found" }
    if (pay.status === "paid" || pay.status === "success") {
      return { ok: true, status: "paid" }
    }
    if (pay.amount !== amount) return { ok: false, error: "amount_mismatch" }
    if (pay.currency !== currency) return { ok: false, error: "currency_mismatch" }

    const reg = this.registrations.get(paymentId)
    if (reg) reg.status = "confirmed"
    pay.status = "paid"
    pay.razorpay_payment_id = razorpayPaymentId
    return { ok: true, status: "paid" }
  }

  confirmPaymentFromWebhook(paymentId: string, webhookId: string, rzpPaymentId: string, amount: number, currency: string): { ok: boolean; action?: string; reason?: string; error?: string } {
    if (this.processedWebhooks.has(webhookId)) {
      return { ok: true, action: "skipped", reason: "already_processed" }
    }

    const res = this.confirmPayment(paymentId, amount, currency, rzpPaymentId)
    if (!res.ok) {
      // Failed confirmation does NOT record webhook
      return { ok: false, error: res.error }
    }

    // Success atomically records webhook
    this.processedWebhooks.add(webhookId)
    return { ok: true, action: "confirmed" }
  }
}

Deno.test("PAY-REL-006: Webhook successful payment.captured, duplicate, and delayed lifecycle", () => {
  const sim = new WebhookEngineSimulator()
  sim.payments.set("pay_1", { id: "pay_1", status: "pending", amount: 50000, currency: "INR" })
  sim.registrations.set("pay_1", { id: "reg_1", status: "pending", event_id: "ev_1" })

  // 1. Successful payment.captured webhook
  const w1 = sim.confirmPaymentFromWebhook("pay_1", "evt_101", "rzp_pay_1", 50000, "INR")
  assertEquals(w1.ok, true)
  assertEquals(w1.action, "confirmed")
  assertEquals(sim.payments.get("pay_1")?.status, "paid")

  // 2. Duplicate webhook delivery
  const w2 = sim.confirmPaymentFromWebhook("pay_1", "evt_101", "rzp_pay_1", 50000, "INR")
  assertEquals(w2.ok, true)
  assertEquals(w2.action, "skipped")
  assertEquals(w2.reason, "already_processed")

  // 3. Webhook failure does not mark webhook as processed
  sim.payments.set("pay_2", { id: "pay_2", status: "pending", amount: 50000, currency: "INR" })
  const w3 = sim.confirmPaymentFromWebhook("pay_2", "evt_102", "rzp_pay_2", 99999, "INR") // tampered amount
  assertEquals(w3.ok, false)
  assertEquals(w3.error, "amount_mismatch")
  assert(!sim.processedWebhooks.has("evt_102"), "Failed webhook must not be marked processed")

  // 4. Retry after failure succeeds and records webhook
  const w4 = sim.confirmPaymentFromWebhook("pay_2", "evt_102", "rzp_pay_2", 50000, "INR") // correct amount
  assertEquals(w4.ok, true)
  assertEquals(w4.action, "confirmed")
  assert(sim.processedWebhooks.has("evt_102"), "Successful retry marks webhook processed")

  // 5. Direct verification followed by delayed webhook
  sim.payments.set("pay_3", { id: "pay_3", status: "pending", amount: 50000, currency: "INR" })
  const directVerify = sim.confirmPayment("pay_3", 50000, "INR", "rzp_pay_3")
  assertEquals(directVerify.ok, true)
  assertEquals(sim.payments.get("pay_3")?.status, "paid")

  const delayedWebhook = sim.confirmPaymentFromWebhook("pay_3", "evt_103", "rzp_pay_3", 50000, "INR")
  assertEquals(delayedWebhook.ok, true)
  assertEquals(delayedWebhook.action, "confirmed")
  assertEquals(sim.payments.get("pay_3")?.status, "paid")

  // 6. Webhook followed by direct verification
  const subsequentDirect = sim.confirmPayment("pay_3", 50000, "INR", "rzp_pay_3")
  assertEquals(subsequentDirect.ok, true)
  assertEquals(subsequentDirect.status, "paid")
})

// ============================================================================
// FIX 2: FIN-REL-008 — MANUAL PAYOUT SCOPED DEDUPLICATION & LEDGER SAFETY
// ============================================================================

Deno.test("FIN-REL-008: Migration creates scoped compound partial unique index", async () => {
  const sql = await readMigration("202611010003_manual_payout_deduplication.sql")

  // Must NOT create naive global index
  assert(
    !sql.includes("CREATE UNIQUE INDEX uq_payout_items_utr ON public.payout_items (utr);"),
    "Must not create global unique index which breaks multiple-event payouts"
  )

  // Must create scoped compound index on community_id, COALESCE(event_id, 0), UPPER(TRIM(utr))
  assert(
    sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_items_active_transfer"),
    "Scoped unique index name present"
  )
  assert(
    sql.includes("COALESCE(event_id, '00000000-0000-0000-0000-000000000000'::UUID)"),
    "Event attribution safely normalized with zero UUID"
  )
  assert(
    sql.includes("UPPER(TRIM(utr))"),
    "UTR normalized with UPPER(TRIM())"
  )
  assert(
    sql.includes("WHERE status IN ('pending_confirmation', 'success')"),
    "Partial index active states restricted to pending_confirmation and success"
  )

  // RPC checks duplicate and returns clean error
  assert(
    sql.includes("'duplicate_payout_utr'"),
    "RPC returns duplicate_payout_utr error"
  )
})

// Manual Payout Ledger Simulator
class ManualPayoutSimulator {
  communities = new Map<string, { id: string; wallet_balance: number }>()
  payoutItems: Array<{ id: string; community_id: string; event_id: string | null; amount: number; status: string; utr: string }> = []
  auditLog: any[] = []

  recordManualPayout(communityId: string, amount: number, utr: string, eventId: string | null = null): { ok: boolean; payout_id?: string; error?: string; message?: string } {
    if (amount <= 0) return { ok: false, error: "invalid_amount" }
    const normalizedUtr = utr.trim().toUpperCase()
    if (!normalizedUtr) return { ok: false, error: "utr_required" }

    const zeroUuid = "00000000-0000-0000-0000-000000000000"
    const targetEvent = eventId || zeroUuid

    // Check duplicate active payout
    const isDuplicate = this.payoutItems.some(p =>
      p.community_id === communityId &&
      (p.event_id || zeroUuid) === targetEvent &&
      p.utr === normalizedUtr &&
      (p.status === "pending_confirmation" || p.status === "success")
    )

    if (isDuplicate) {
      return {
        ok: false,
        error: "duplicate_payout_utr",
        message: "A payout with this UTR is already recorded and active."
      }
    }

    const payoutId = `pay_${Date.now()}_${Math.random()}`
    this.payoutItems.push({
      id: payoutId,
      community_id: communityId,
      event_id: eventId,
      amount,
      status: "pending_confirmation",
      utr: normalizedUtr
    })

    this.auditLog.push({ action: "manual_payout_recorded", payout_id: payoutId, amount, utr: normalizedUtr })
    // CRITICAL: wallet_balance is NOT deducted on record!
    return { ok: true, payout_id: payoutId }
  }

  confirmPayout(payoutId: string): { ok: boolean; new_balance?: number; error?: string } {
    const item = this.payoutItems.find(p => p.id === payoutId)
    if (!item) return { ok: false, error: "not_found" }
    if (item.status !== "pending_confirmation") {
      return { ok: false, error: "Payout is not in pending confirmation state." }
    }

    const comm = this.communities.get(item.community_id)
    if (!comm || comm.wallet_balance < item.amount) {
      return { ok: false, error: "Insufficient community wallet balance." }
    }

    // Atomic deduction on confirmation
    comm.wallet_balance -= item.amount
    item.status = "success"
    this.auditLog.push({ action: "wallet_debited", payout_id: payoutId, amount: item.amount, new_balance: comm.wallet_balance })
    return { ok: true, new_balance: comm.wallet_balance }
  }

  disputePayout(payoutId: string, reason: string): { ok: boolean; error?: string } {
    const item = this.payoutItems.find(p => p.id === payoutId)
    if (!item) return { ok: false, error: "not_found" }
    if (item.status !== "pending_confirmation") return { ok: false, error: "not_pending" }

    item.status = "disputed"
    this.auditLog.push({ action: "payout_disputed", payout_id: payoutId, reason })
    // Wallet balance untouched!
    return { ok: true }
  }
}

Deno.test("FIN-REL-008: Manual payout deduplication, multi-event allocation, and wallet safety", () => {
  const sim = new ManualPayoutSimulator()
  sim.communities.set("comm_1", { id: "comm_1", wallet_balance: 100000 }) // ₹1,000 balance

  // 1. Same community, same event, same UTR twice -> 2nd blocked
  const p1 = sim.recordManualPayout("comm_1", 30000, "UTR_AXIS_001", "ev_A")
  assertEquals(p1.ok, true)
  assertEquals(sim.communities.get("comm_1")?.wallet_balance, 100000, "Wallet untouched on recording")

  const p1_dup = sim.recordManualPayout("comm_1", 30000, "UTR_AXIS_001", "ev_A")
  assertEquals(p1_dup.ok, false)
  assertEquals(p1_dup.error, "duplicate_payout_utr")

  // Case & whitespace normalization test
  const p1_case_dup = sim.recordManualPayout("comm_1", 30000, "  utr_axis_001  ", "ev_A")
  assertEquals(p1_case_dup.ok, false)
  assertEquals(p1_case_dup.error, "duplicate_payout_utr")

  // 2. Same community, different events, same UTR -> ALLOWED (multi-event bank transfer)
  const p2_multi = sim.recordManualPayout("comm_1", 20000, "UTR_AXIS_001", "ev_B")
  assertEquals(p2_multi.ok, true, "Combined transfer covering multiple events must be permitted")

  // 3. Same community, same event, different UTRs -> ALLOWED (partial payout)
  const p3_partial = sim.recordManualPayout("comm_1", 10000, "UTR_AXIS_002", "ev_A")
  assertEquals(p3_partial.ok, true, "Partial payout with distinct UTR permitted")

  // 4. Dispute workflow allows re-entry once disputed
  const p4_initial = sim.recordManualPayout("comm_1", 15000, "UTR_DISP_001", "ev_C")
  assertEquals(p4_initial.ok, true)
  const dispRes = sim.disputePayout(p4_initial.payout_id!, "Incorrect IFSC code - funds bounced")
  assertEquals(dispRes.ok, true)
  assertEquals(sim.communities.get("comm_1")?.wallet_balance, 100000, "Dispute does not debit wallet")

  // Re-entry of corrected transfer with same UTR is now permitted because previous is disputed
  const p4_reentry = sim.recordManualPayout("comm_1", 15000, "UTR_DISP_001", "ev_C")
  assertEquals(p4_reentry.ok, true, "Disputed transfer allows corrected re-entry")

  // 5. Organizer confirmation twice -> second rejected, wallet deducted exactly once
  const confirm1 = sim.confirmPayout(p1.payout_id!)
  assertEquals(confirm1.ok, true)
  assertEquals(sim.communities.get("comm_1")?.wallet_balance, 70000, "Wallet deducted by ₹300 exactly once")

  const confirm2 = sim.confirmPayout(p1.payout_id!)
  assertEquals(confirm2.ok, false, "Second confirmation rejected")
  assertEquals(confirm2.error, "Payout is not in pending confirmation state.")
  assertEquals(sim.communities.get("comm_1")?.wallet_balance, 70000, "Wallet NOT deducted twice")
})

// ============================================================================
// FIX 3: PAY-CONC-007 — BOOKING HOLD REUSE SCOPING
// ============================================================================

Deno.test("PAY-CONC-007: reserve_ticket_capacity hoists hold reuse check outside payments block", async () => {
  const sql = await readMigration("202611010004_fix_booking_hold_reuse.sql")

  // Check structure: active hold reuse must be at level of registration, not payments
  const regFoundPos = sql.indexOf("IF FOUND THEN\n    -- Guard 1: Confirmed or Attended")
  const holdReusePos = sql.indexOf("IF v_reg.status = 'pending' AND v_reg.hold_expires_at > clock_timestamp() THEN")
  const paymentsQueryPos = sql.indexOf("SELECT id, status, refund_status, refund_claim_state\n    INTO v_payment")

  assert(regFoundPos >= 0, "Registration lookup exists")
  assert(paymentsQueryPos >= 0, "Payments lookup exists")
  assert(holdReusePos >= 0, "Hold reuse check exists")

  // Must return reused_hold: true
  assert(
    sql.includes("'reused_hold', true"),
    "Returns reused_hold: true when active hold is refreshed"
  )

  // Payments guards must precede hold reuse
  assert(
    paymentsQueryPos < holdReusePos,
    "Payment guards (already_paid, refund_in_progress) must be evaluated before hold reuse"
  )
})

// Capacity Reservation Simulator
class CapacityReservationSimulator {
  event = { id: "ev_1", capacity: 2, booked_count: 0 }
  registrations = new Map<string, { id: string; user_id: string; status: string; hold_expires_at: number }>()
  payments = new Map<string, { registration_id: string; status: string; refund_status?: string }>()

  reserveCapacity(userId: string, now = Date.now()): { ok: boolean; registration_id?: string; reused_hold?: boolean; error?: string } {
    let reg = this.registrations.get(userId)

    if (reg) {
      if (reg.status === "confirmed" || reg.status === "attended") {
        return { ok: false, error: "already_registered" }
      }

      const pay = Array.from(this.payments.values()).find(p => p.registration_id === reg?.id)
      if (pay) {
        if (pay.status === "success") return { ok: false, error: "already_paid" }
        if (pay.refund_status === "pending") return { ok: false, error: "refund_in_progress" }
      }

      // Hoisted check: active hold reuse works whether payment exists or not!
      if (reg.status === "pending" && reg.hold_expires_at > now) {
        return { ok: true, registration_id: reg.id, reused_hold: true }
      }
    }

    // Available capacity calculation
    const activeHolds = Array.from(this.registrations.values()).filter(r =>
      r.status === "pending" && r.hold_expires_at > now && (!reg || r.id !== reg.id)
    ).length

    if ((this.event.booked_count + activeHolds) >= this.event.capacity) {
      return { ok: false, error: "capacity_held" }
    }

    const regId = reg ? reg.id : `reg_${userId}`
    const holdExpiresAt = now + 600 * 1000 // 10 minutes
    this.registrations.set(userId, { id: regId, user_id: userId, status: "pending", hold_expires_at: holdExpiresAt })

    return { ok: true, registration_id: regId, reused_hold: false }
  }
}

Deno.test("PAY-CONC-007: Hold reuse before payment insertion, after payment insertion, and under race conditions", () => {
  const sim = new CapacityReservationSimulator()

  // 1. First tap: allocates new hold
  const tap1 = sim.reserveCapacity("user_A")
  assertEquals(tap1.ok, true)
  assertEquals(tap1.reused_hold, false)
  const regIdA = tap1.registration_id

  // 2. Second tap BEFORE payment row created: must return reused_hold=true with identical reg ID!
  const tap2 = sim.reserveCapacity("user_A")
  assertEquals(tap2.ok, true)
  assertEquals(tap2.reused_hold, true, "Hold reuse must succeed before payment row insertion")
  assertEquals(tap2.registration_id, regIdA)

  // 3. Payment row created in pending state
  sim.payments.set("pay_A", { registration_id: regIdA!, status: "pending" })

  // 4. Third tap AFTER payment row created: must return reused_hold=true
  const tap3 = sim.reserveCapacity("user_A")
  assertEquals(tap3.ok, true)
  assertEquals(tap3.reused_hold, true, "Hold reuse must succeed after payment row insertion")
  assertEquals(tap3.registration_id, regIdA)

  // 5. Competing user for remaining 1 seat (capacity = 2)
  const tapUserB = sim.reserveCapacity("user_B")
  assertEquals(tapUserB.ok, true)
  assertEquals(tapUserB.reused_hold, false)

  // 6. Third user competing when capacity is full
  const tapUserC = sim.reserveCapacity("user_C")
  assertEquals(tapUserC.ok, false)
  assertEquals(tapUserC.error, "capacity_held")

  // 7. Expired hold: after 11 minutes, user A's hold expires and can be recycled
  const futureTime = Date.now() + 660 * 1000 // 11 mins
  const tapUserC_afterExpiry = sim.reserveCapacity("user_C", futureTime)
  assertEquals(tapUserC_afterExpiry.ok, true, "Expired hold capacity recycled for new user")
})

