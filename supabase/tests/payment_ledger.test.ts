// ============================================================================
// CLUVO — Immutable payment ledger: static regression suite.
//
// These tests lock in the financial invariants of the 20261107 ledger
// migrations. They are intentionally static (read the SQL/TS sources) so they
// run in CI with only --allow-read, while the live behaviour is verified
// against a disposable database by scripts/verify_payment_ledger.ts.
// ============================================================================

import { assert } from "jsr:@std/assert"

const migrations = new URL("../migrations/", import.meta.url)

async function migration(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, migrations))
}

async function source(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(`../../${path}`, import.meta.url))
}

const sales = await migration("202611070001_payment_sales_ledger.sql")
const confirm = await migration("202611070002_confirm_payment_writes_sale.sql")
const refund = await migration("202611070003_refund_ledger.sql")
const statements = await migration("202611070004_statements_read_ledger.sql")
const credentials = await migration("202611070005_ticket_credential_safety.sql")
const payouts = await migration("202611070006_payout_reserves_durable_clawbacks.sql")
const overload = await migration("202611070007_drop_stale_confirm_payment_overload.sql")
const adminWriters = await migration("202611070008_admin_writers_durable_clawbacks.sql")

Deno.test("payment_sales is an append-only, one-row-per-capture ledger", () => {
  assert(sales.includes("CREATE TABLE IF NOT EXISTS public.payment_sales"))
  assert(sales.includes("CONSTRAINT payment_sales_capture_uniq UNIQUE (razorpay_payment_id)"))

  // Append-only: UPDATE/DELETE raise, not just "no policy".
  assert(sales.includes("CREATE TRIGGER trg_payment_sales_immutable"))
  assert(sales.includes("BEFORE UPDATE OR DELETE ON public.payment_sales"))
  assert(sales.includes("Financial records are append-only"))

  // A sale cannot be pointed at a registration/event/payment that may vanish.
  for (const [column, table] of [
    ["payment_id", "payments"],
    ["registration_id", "registrations"],
    ["event_id", "events"],
    ["community_id", "communities"],
  ]) {
    const link = new RegExp(`${column}\\s+uuid NOT NULL REFERENCES public\\.${table}\\(id\\) ON DELETE RESTRICT`)
    assert(link.test(sales), `missing RESTRICT link: ${column} -> ${table}`)
  }
})

Deno.test("backfill only records money that actually moved", () => {
  assert(sales.includes("WHERE p.razorpay_payment_id IS NOT NULL"))
  assert(sales.includes("AND p.status IN ('success', 'refunded')"))
  assert(sales.includes("AND p.deleted_at IS NULL"))
  assert(sales.includes("ON CONFLICT (razorpay_payment_id) DO NOTHING"))
})

Deno.test("refund_clawbacks is durable debt, not a mutable payments column", () => {
  assert(sales.includes("CREATE TABLE IF NOT EXISTS public.refund_clawbacks"))
  assert(/refund_id\s+uuid NOT NULL UNIQUE REFERENCES public\.payment_refund_history\(id\) ON DELETE RESTRICT/.test(sales))
  assert(sales.includes("CREATE TRIGGER trg_refund_clawbacks_guard"))
  assert(sales.includes("refund_clawbacks financial identity is immutable"))

  // The legacy pending debt is migrated into the durable table.
  assert(sales.includes("WHERE p.refund_clawback_state = 'pending'"))
  assert(sales.includes("ON CONFLICT (refund_id) DO NOTHING"))
})

Deno.test("ledger tables grant SELECT only to authenticated", () => {
  assert(sales.includes("REVOKE ALL ON public.payment_sales FROM PUBLIC, anon, authenticated"))
  assert(sales.includes("REVOKE ALL ON public.refund_clawbacks FROM PUBLIC, anon, authenticated"))
  assert(sales.includes("GRANT SELECT ON public.payment_sales TO authenticated"))
  assert(sales.includes("GRANT SELECT ON public.refund_clawbacks TO authenticated"))
  assert(sales.includes("ALTER TABLE public.payment_sales ENABLE ROW LEVEL SECURITY"))
  assert(sales.includes("ALTER TABLE public.refund_clawbacks ENABLE ROW LEVEL SECURITY"))
})

Deno.test("confirm_payment writes a sale and gates the wallet credit on it", () => {
  assert(confirm.includes("INSERT INTO public.payment_sales"))
  assert(confirm.includes("ON CONFLICT (razorpay_payment_id) DO NOTHING"))
  assert(confirm.includes("RETURNING id INTO v_sale_id"))

  // The insert is the idempotency key: duplicate webhooks cannot double-credit.
  assert(confirm.includes("IF v_sale_id IS NOT NULL THEN"))
  assert(confirm.includes("PERFORM public.credit_wallet"))

  // The credit must be inside the gate, not before it.
  const gate = confirm.indexOf("IF v_sale_id IS NOT NULL THEN")
  const credit = confirm.indexOf("PERFORM public.credit_wallet")
  assert(gate !== -1 && credit > gate, "credit_wallet must be gated by the sale insert")

  // A capture with no provider id can never be recorded as a sale.
  assert(confirm.includes("Missing Razorpay payment id"))

  // A stale capture must not confirm a row that already owns another capture.
  assert(confirm.includes("capture_id_mismatch"))

  // QR rotates on every confirm (no COALESCE resurrecting a revoked token).
  assert(!confirm.includes("COALESCE(\n        v_reg.qr_code"))
  assert(confirm.includes("sha256((gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text)::bytea)"))
})

Deno.test("confirm_payment heals a legacy sale without re-crediting", () => {
  const heal = confirm.indexOf("Already confirmed: heal a missing sale row")
  const healEnd = confirm.indexOf("IF v_reg.status = 'cancelled'")
  assert(heal !== -1 && healEnd > heal)
  const healBody = confirm.slice(heal, healEnd)
  assert(healBody.includes("INSERT INTO public.payment_sales"))
  assert(!healBody.includes("credit_wallet"))
})

Deno.test("refunds are linked to the sale they reverse", () => {
  assert(refund.includes("CREATE OR REPLACE FUNCTION public.current_sale_id"))
  assert(refund.includes("ALTER TABLE") === false) // schema change lives in 202611070001
  assert(refund.includes("sale_id = COALESCE(sale_id, v_sale.id)"))
  assert(refund.includes("organizer_clawed"))
  assert(refund.includes("fee_kept"))

  // Clawback amount is snapshotted from the sale, never the mutable row.
  assert(refund.includes("COALESCE(v_sale.ticket_amount, v_payment.organizer_share, 0)"))
})

Deno.test("settlement writes durable debt before and after the wallet debit", () => {
  assert(refund.includes("INSERT INTO public.refund_clawbacks"))
  assert(refund.includes("WHERE refund_id = v_refund_row_id"))
  assert(refund.includes("FOR UPDATE"))
  assert(refund.includes("IF v_clawback.state = 'done'"))
  assert(refund.includes("already_debited"))

  // Short wallet keeps a pending debt and an alert; it never drops the debt.
  assert(refund.includes("clawback_pending', true"))
  assert(refund.includes("refund_wallet_debit_failed"))
  assert(refund.includes("Refund clawback pending: organizer wallet short"))
})

Deno.test("retry job reads the durable table, not the payment mirror", () => {
  const retry = refund.slice(refund.indexOf("CREATE OR REPLACE FUNCTION public.retry_refund_clawbacks"))
  assert(retry.includes("FROM public.refund_clawbacks"))
  assert(retry.includes("WHERE state = 'pending'"))
  assert(retry.includes("FOR UPDATE SKIP LOCKED"))
  assert(retry.includes("SET state = 'done'"))
})

Deno.test("statements read payment_sales and keep ledger refunds visible", () => {
  assert(statements.includes("FROM public.payment_sales s"))
  assert(statements.includes("s.gross_amount AS gross_amount"))
  assert(statements.includes("s.ticket_amount AS organizer_share"))

  // A refund recorded in the ledger is real even if the mutable payment row
  // was re-quoted or its wallet clawback is still pending.
  const occurrences = statements.split("d.sale_id IS NOT NULL").length - 1
  assert(occurrences === 2, "both admin and organizer statements must include ledger refunds")

  // Deterministic running balance ordering.
  assert(statements.includes("ORDER BY rt.created_at ASC, rt.transaction_id ASC"))
})

Deno.test("event cancellation revokes credentials atomically", () => {
  assert(credentials.includes("CREATE TRIGGER trg_clear_event_qr_on_cancelling"))
  assert(credentials.includes("AFTER UPDATE OF status ON public.events"))
  assert(credentials.includes("SET qr_code = NULL"))
  assert(credentials.includes("NEW.status = 'cancelling'"))

  // Check-in refuses both lifecycle states.
  assert(credentials.includes("e.status IN ('cancelled', 'cancelling')"))
})

Deno.test("payouts reserve the durable clawback debt", () => {
  const payoutReads = payouts.split("FROM public.refund_clawbacks cb").length - 1
  assert(payoutReads >= 3, "payout writers and liability summary must read refund_clawbacks")

  assert(payouts.includes("v_community_clawback_pending"))
  assert(payouts.includes("refund_clawbacks cb\n  WHERE cb.community_id = p_community_id"))
  assert(payouts.includes("guard_pending_clawback_clear"))
  assert(payouts.includes("Cannot clear a pending refund clawback with an unsettled debt row"))
})

Deno.test("the stale single-argument confirm_payment overload is removed", () => {
  assert(overload.includes("DROP FUNCTION IF EXISTS public.confirm_payment(uuid)"))
  assert(overload.includes("GRANT EXECUTE ON FUNCTION public.confirm_payment(uuid, integer, text, text)"))
})

Deno.test("admin refund writers persist durable clawback debt", () => {
  // Adopt + offline settlement must link the refund to its sale.
  assert(adminWriters.includes("CREATE OR REPLACE FUNCTION public.admin_adopt_provider_refund"))
  assert(adminWriters.includes("CREATE OR REPLACE FUNCTION public.admin_manual_settlement"))
  assert(adminWriters.includes("public.current_sale_id(v_payment.id)"))

  // Both must write refund_clawbacks, not just the mirror column.
  const inserts = adminWriters.split("INSERT INTO public.refund_clawbacks").length - 1
  assert(inserts >= 3, "adopt, offline settlement and the legacy sweep must all insert debt")

  assert(adminWriters.includes("refund_clawback_state = v_clawback_state"))
  assert(adminWriters.includes("refund_wallet_debit_failed"))

  // The retry job migrates debt written by an older, mirror-only release.
  assert(adminWriters.includes("Safety net for debt written by a release that only knew the mirror column"))
  assert(adminWriters.includes("WHERE p.refund_clawback_state = 'pending'"))
  assert(adminWriters.includes("ON CONFLICT (refund_id) DO NOTHING"))
})

Deno.test("edge function requote never clears a pending clawback", async () => {
  const payments = await source("supabase/functions/_shared/payments.ts")
  const start = payments.indexOf("export async function clearRefundFieldsForRequote")
  const end = payments.indexOf("export async function restoreRegistrationIfCancelled")
  assert(start !== -1 && end > start)
  const body = payments.slice(start, end)

  assert(body.includes("prior_refund_clawback_state"))
  assert(body.includes("prior_refund_wallet_debited_attempt"))
  assert(!body.includes("refund_clawback_state: \"none\""))
  assert(!body.includes("refund_wallet_debited_attempt: 0"))
})

Deno.test("mobile history dedupes refunds by provider id, not by payment", async () => {
  let provider: string
  try {
    provider = await source("apps/mobile/lib/providers/activity_provider.dart")
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return // mobile app lives in its own repo in CI
    throw err
  }
  assert(provider.includes("liveRefundIds"))
  assert(provider.includes("razorpay_refund_id"))
  assert(!provider.includes("liveRefundByPayment"))
})

Deno.test("mobile treats a cancelling event as cancelled and hides the QR", async () => {
  let registrations: string
  let ticket: string
  try {
    registrations = await source("apps/mobile/lib/screens/my_registrations_screen.dart")
    ticket = await source("apps/mobile/lib/screens/ticket_screen.dart")
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return // mobile app lives in its own repo in CI
    throw err
  }

  assert(registrations.includes("eventStatus == 'cancelling'"))
  assert(ticket.includes("eventStatus == 'cancelling'"))
  assert(ticket.includes("qrData: status == 'confirmed' ? qrCode : null"))
})
