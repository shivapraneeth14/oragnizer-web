// Static policy gate: "the platform fee is never refunded once the customer
// held a ticket". Locks the server amount, the persisted claim amount, the
// audit action and all customer-facing copy to the same rule, so a future edit
// to one layer cannot silently drift back to a full refund.
// Run: deno test --allow-read supabase/tests/refund_fee_policy.test.ts

import { assert, assertEquals } from "jsr:@std/assert"

const root = new URL("../../", import.meta.url)
const read = (path: string) => Deno.readTextFile(new URL(path, root))

Deno.test("refundAmountForPayment: organizer_share wins, else full amount", async () => {
  const src = await read("supabase/functions/_shared/refunds.ts")
  assert(src.includes("export function refundAmountForPayment"))
  assert(
    src.includes("if (payment.organizer_share != null) return Math.max(Number(payment.organizer_share), 0)"),
    "confirmed bookings must refund the ticket price and keep the fee",
  )
  assert(src.includes("return Math.max(Number(payment.amount ?? 0), 0)"))
})

Deno.test("cancel_registration_and_claim_refund persists the ticket amount", async () => {
  const sql = await read("supabase/migrations/202611040001_organizer_refund_keeps_fee.sql")
  assert(sql.includes("CREATE OR REPLACE FUNCTION public.cancel_registration_and_claim_refund"))
  assert(
    sql.includes("refund_amount_due = COALESCE(v_payment.organizer_share"),
    "must persist organizer_share (fallback amount - fee)",
  )
  assert(!sql.includes("refund_amount_due = v_payment.amount,"), "must not persist the full amount")
})

Deno.test("statement RPCs no longer subtract the fee from refund debits", async () => {
  const sql = await read("supabase/migrations/202611040002_statement_refund_debit_fee_kept.sql")
  for (const fn of [
    "run_financial_reconciliation",
    "get_admin_financial_statement",
    "get_organizer_financial_statement",
    "admin_record_manual_payout",
  ]) {
    assert(sql.includes(`FUNCTION public.${fn}`), `${fn} missing`)
  }
  assert(!sql.includes("d.refund_reason = 'event_cancellation'"), "old fee-subtracting CASE must be gone")
  assert(sql.includes("COALESCE(p.organizer_share, 0)"))
})

Deno.test("organizer-initiated and worker refunds use the ticket amount", async () => {
  for (const path of [
    "supabase/functions/issue-refund/index.ts",
    "supabase/functions/process-cancellation-queue/index.ts",
  ]) {
    const src = await read(path)
    assert(src.includes("refundAmountForPayment(payment)"), `${path} must refund the ticket amount`)
    assert(src.includes("platform_fee_kept"), `${path} must record the kept fee`)
    assert(!src.includes('action: "commission_reversed"'), `${path} must not claim the fee was reversed`)
  }
})

Deno.test("organizer legal copy says the fee is not refunded on event cancellation", async () => {
  const src = await read("apps/organizer-web/src/legal/fee-sections.tsx")
  assert(src.includes("refunded the ticket price only"))
  assert(src.includes("platform fee is not refunded"))
  assert(!src.includes("refunded in full — including the platform fee"))
})

Deno.test("customer mobile disclosure no longer promises the fee back on organizer cancellation", async () => {
  const src = await read("apps/mobile/lib/screens/event_detail_screen.dart")
  assert(src.includes("refund of the ticket price only"))
  assert(!src.includes("full refund, including the platform fee"))
})

Deno.test("mobile refund displays fall back to organizer_share, then full amount", async () => {
  const paymentDetail = await read("apps/mobile/lib/screens/payment_detail_screen.dart")
  const myPayments = await read("apps/mobile/lib/screens/my_payments_screen.dart")
  const myRegistrations = await read("apps/mobile/lib/screens/my_registrations_screen.dart")

  assertEquals(paymentDetail.includes("organizerSharePaise"), true)
  assertEquals(paymentDetail.includes("refundDisplayPaise = organizerSharePaise"), true)
  assertEquals(myPayments.includes("displayAmount = organizerShare"), true)
  assertEquals(myRegistrations.includes("refundDisplay = organizerShare"), true)

  for (const src of [paymentDetail, myPayments, myRegistrations]) {
    assert(
      !src.includes("amountPaise - platformFee") &&
        !src.includes("amount - platformFee") &&
        !src.includes("paidAmount - platformFee"),
      "old amount-minus-fee fallback must be gone",
    )
  }
})

Deno.test("mobile activity query selects organizer_share for the embedded payment", async () => {
  const src = await read("apps/mobile/lib/providers/activity_provider.dart")
  assert(src.includes("platform_fee, organizer_share"))
})
