// Regression gate for the W3 fix: the refund clawback must never debit an
// organizer share that was never credited (capacity_full / cancelled-while-pending).
// Run: deno test --allow-read supabase/tests/refund_clawback_guard.test.ts

import { assert } from "jsr:@std/assert"

const MIGRATION = new URL("../migrations/202611030004_fix_refund_clawback_uncredited.sql", import.meta.url)
const sql = await Deno.readTextFile(MIGRATION)

Deno.test("complete_payment_refund claws back only the persisted organizer_share", () => {
  assert(sql.includes("CREATE OR REPLACE FUNCTION public.complete_payment_refund"))
  assert(sql.includes("GREATEST(COALESCE(v_payment.organizer_share, 0), 0)"))
})

Deno.test("the amount-minus-fee fallback is removed from the clawback", () => {
  // The buggy fallback credited the organizer even when organizer_share was NULL.
  assert(!sql.includes("GREATEST(COALESCE(v_payment.amount, 0) - COALESCE(v_payment.platform_fee, 0), 0)"))
})

Deno.test("the wallet debit still threads payment_id (M2 preserved)", () => {
  assert(sql.includes("debit_wallet(v_community_id, v_organizer_share, p_wallet_reason, v_event_id, p_payment_id)"))
})
