// ============================================================================
// CLUVO — live integration verification of the immutable payment ledger.
//
// Run against the LOCAL Docker database only:
//
//   deno run --allow-net --allow-env --no-lock --node-modules-dir=none \
//     scripts/verify_payment_ledger.ts
//
// Everything runs inside ONE transaction that is rolled back, so it is safe to
// point at a disposable local database and it never leaves fixtures behind.
// It exercises the real SQL functions (confirm_payment, cancel RPCs,
// complete_payment_refund, settle, retry, statements, payout reservation),
// not mocks.
// ============================================================================

import postgres from "npm:postgres"

const DB_URL = Deno.env.get("LEDGER_DB_URL") ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

const sql = postgres(DB_URL, { max: 1, idle_timeout: 5, onnotice: () => {} })

let passed = 0
const failures: string[] = []

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
  passed++
  console.log(`  PASS  ${msg}`)
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  )
}

async function expectError(fn: () => Promise<unknown>, contains: string, msg: string): Promise<void> {
  // A raised error aborts the whole transaction, so isolate it in a savepoint.
  await sql.unsafe("SAVEPOINT expected_error")
  try {
    await fn()
  } catch (err) {
    await sql.unsafe("ROLLBACK TO SAVEPOINT expected_error")
    const message = err instanceof Error ? err.message : String(err)
    assert(message.toLowerCase().includes(contains.toLowerCase()),
      `${msg} [error: ${message}]`)
    return
  }
  await sql.unsafe("RELEASE SAVEPOINT expected_error")
  throw new Error(`${msg} — expected an error containing "${contains}" but none was raised`)
}

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`
  try {
    return await fn()
  } finally {
    await sql`select set_config('request.jwt.claims', '', true)`
  }
}

function uuid(): string {
  return crypto.randomUUID()
}

const ids = {
  organizer: uuid(),
  attendee: uuid(),
  attendee2: uuid(),
  admin: uuid(),
  community: uuid(),
  event1: uuid(),
  event2: uuid(),
  event3: uuid(),
  event4: uuid(),
  event5: uuid(),
  reg1: uuid(),
  reg2: uuid(),
  reg3: uuid(),
  reg4: uuid(),
  reg5: uuid(),
  reg6: uuid(),
  pay1: uuid(),
  pay2: uuid(),
  pay3: uuid(),
  pay4: uuid(),
  pay5: uuid(),
  pay6: uuid(),
}

const captures = {
  saleA: `pay_A_${Date.now()}`,
  saleC: `pay_C_${Date.now()}`,
  saleE: `pay_E_${Date.now()}`,
  saleG: `pay_G_${Date.now()}`,
  stale: `pay_STALE_${Date.now()}`,
}

const refunds = {
  first: `rfnd_B_${Date.now()}`,
  second: `rfnd_D_${Date.now()}`,
  event: `rfnd_G_${Date.now()}`,
}

async function seedUsers(): Promise<void> {
  const users = [
    { id: ids.organizer, email: "ledger-organizer@cluvo.test", first: "Ledger", last: "Organizer", username: "ledger_org" },
    { id: ids.attendee, email: "ledger-attendee@cluvo.test", first: "Ledger", last: "Attendee", username: "ledger_att" },
    { id: ids.attendee2, email: "ledger-attendee2@cluvo.test", first: "Ledger", last: "Attendee2", username: "ledger_att2" },
    { id: ids.admin, email: "ledger-admin@cluvo.test", first: "Ledger", last: "Admin", username: "ledger_admin" },
  ]
  for (const u of users) {
    await sql`
      INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
      VALUES (
        ${u.id}::uuid,
        ${u.email},
        '{"provider":"email","cluvo_provisioned":true}'::jsonb,
        ${JSON.stringify({ first_name: u.first, last_name: u.last, username: u.username })}::jsonb
      )
    `
  }
  await sql`UPDATE public.profiles SET is_admin = TRUE WHERE id = ${ids.admin}::uuid`
}

async function seedCommunityAndEvents(): Promise<void> {
  await sql`
    INSERT INTO public.communities (id, name, description, owner_id, wallet_balance)
    VALUES (${ids.community}::uuid, 'Ledger Community', 'ledger verification', ${ids.organizer}::uuid, 0)
  `
  await sql`
    INSERT INTO public.events (id, community_id, title, description, start_date, end_date, price, capacity, status)
    VALUES
      (${ids.event1}::uuid, ${ids.community}::uuid, 'Ledger Event 1', 'one',
       now() + interval '7 days', now() + interval '8 days', 100000, 10, 'published'),
      (${ids.event2}::uuid, ${ids.community}::uuid, 'Ledger Event 2', 'two',
       now() + interval '14 days', now() + interval '15 days', 100000, 10, 'published'),
      (${ids.event3}::uuid, ${ids.community}::uuid, 'Ledger Event 3', 'three',
       now() + interval '21 days', now() + interval '22 days', 100000, 10, 'published'),
      (${ids.event4}::uuid, ${ids.community}::uuid, 'Ledger Event 4', 'four',
       now() + interval '28 days', now() + interval '29 days', 100000, 10, 'published'),
      (${ids.event5}::uuid, ${ids.community}::uuid, 'Ledger Event 5', 'five',
       now() + interval '35 days', now() + interval '36 days', 100000, 10, 'published')
  `
}

async function seedRegistration(
  regId: string,
  eventId: string,
  payId: string,
  orderId: string,
  userId: string = ids.attendee,
): Promise<void> {
  await sql`
    INSERT INTO public.registrations (id, event_id, user_id, status)
    VALUES (${regId}::uuid, ${eventId}::uuid, ${userId}::uuid, 'pending')
  `
  await sql`
    INSERT INTO public.payments
      (id, registration_id, amount, currency, status, razorpay_order_id, platform_fee, attempt_count)
    VALUES
      (${payId}::uuid, ${regId}::uuid, 100000, 'INR', 'pending', ${orderId}, 6000, 1)
  `
}

// Mirrors create-payment + clearRefundFieldsForRequote for a cancel -> rebook
// cycle: the payment row is reused, refund fields are archived/cleared, but the
// durable clawback mirror must remain.
async function requote(payId: string, orderId: string): Promise<void> {
  await sql`
    UPDATE public.payments
    SET status = 'pending',
        razorpay_order_id = ${orderId},
        razorpay_payment_id = NULL,
        razorpay_refund_id = NULL,
        refund_status = NULL,
        refunded_amount = NULL,
        refund_claim_state = 'none',
        refund_claim_at = NULL,
        refund_reason = NULL,
        refund_amount_due = NULL,
        refund_attempt_count = 0,
        attempt_count = attempt_count + 1,
        organizer_share = NULL,
        platform_fee = 6000,
        updated_at = now()
    WHERE id = ${payId}::uuid
  `
  await sql`
    UPDATE public.registrations
    SET status = 'pending', deleted_at = NULL, qr_code = NULL, hold_expires_at = NULL, updated_at = now()
    WHERE id = ${ids.reg1}::uuid AND status = 'cancelled'
  `
}

async function wallet(): Promise<number> {
  const [row] = await sql`SELECT wallet_balance FROM public.communities WHERE id = ${ids.community}::uuid`
  return row.wallet_balance
}

async function sales(): Promise<Array<Record<string, unknown>>> {
  return await sql`SELECT * FROM public.payment_sales WHERE community_id = ${ids.community}::uuid ORDER BY captured_at`
}

async function statement(eventId: string | null = null): Promise<Array<Record<string, unknown>>> {
  return await asUser(ids.admin, async () => {
    const [row] = await sql`SELECT public.get_admin_financial_statement(${ids.community}::uuid, ${eventId}::uuid) AS data`
    return (row.data ?? []) as Array<Record<string, unknown>>
  })
}

async function main(): Promise<void> {
  await sql.unsafe("BEGIN")

  console.log("\n== SETUP ==")
  await seedUsers()
  await seedCommunityAndEvents()
  await seedRegistration(ids.reg1, ids.event1, ids.pay1, "order_A")
  console.log("  fixture seeded")

  // -------------------------------------------------------------------------
  console.log("\n== A. CONFIRM CAPTURE WRITES AN IMMUTABLE SALE ==")
  const [confirmA] = await sql`
    SELECT public.confirm_payment(${ids.pay1}::uuid, 100000, 'INR', ${captures.saleA}) AS res
  `
  assertEq(confirmA.res.action, "confirmed", "confirm_payment reports confirmed")
  assertEq(await wallet(), 94000, "organizer wallet credited exactly the ticket amount")

  let saleRows = await sales()
  assertEq(saleRows.length, 1, "exactly one sale written")
  assertEq(saleRows[0].gross_amount, 100000, "sale gross = captured amount")
  assertEq(saleRows[0].platform_fee, 6000, "sale platform fee snapshot")
  assertEq(saleRows[0].ticket_amount, 94000, "sale organizer share snapshot")
  assertEq(saleRows[0].razorpay_payment_id, captures.saleA, "sale carries the capture id")
  const saleAId = saleRows[0].id as string

  const [paymentA] = await sql`SELECT p.status AS payment_status, r.qr_code FROM public.payments p JOIN public.registrations r ON r.id = p.registration_id WHERE p.id = ${ids.pay1}::uuid`
  assertEq(paymentA.payment_status, "success", "payment row is success")
  const qrA = paymentA.qr_code as string
  assert(qrA?.startsWith("cluvo_"), "a fresh QR credential was issued")

  // duplicate confirm (same capture)
  const [dupA] = await sql`SELECT public.confirm_payment(${ids.pay1}::uuid, 100000, 'INR', ${captures.saleA}) AS res`
  assertEq(dupA.res.skipped, true, "duplicate confirm is a no-op")
  assertEq(await wallet(), 94000, "duplicate confirm cannot double-credit the wallet")
  assertEq((await sales()).length, 1, "duplicate confirm cannot write a second sale")

  // duplicate webhook
  const [whA] = await sql`SELECT public.confirm_payment_from_webhook(${ids.pay1}::uuid, ${"wh_A_" + Date.now()}, ${captures.saleA}, 100000) AS res`
  assertEq(whA.res.skipped, true, "duplicate webhook is skipped")
  assertEq(await wallet(), 94000, "duplicate webhook cannot double-credit the wallet")
  assertEq((await sales()).length, 1, "duplicate webhook cannot write a second sale")

  // stale capture webhook after the row moved on must not confirm
  const [stale] = await sql`SELECT public.confirm_payment_from_webhook(${ids.pay1}::uuid, ${"wh_stale_" + Date.now()}, ${captures.stale}, 100000) AS res`
  assertEq(stale.res.reason, "capture_id_mismatch", "a capture id that does not own the row is refused")
  assertEq(await wallet(), 94000, "refused capture does not move money")

  // append-only guarantees
  await expectError(
    () => sql`UPDATE public.payment_sales SET gross_amount = 1 WHERE id = ${saleAId}::uuid`,
    "append-only",
    "payment_sales UPDATE is blocked",
  )
  await expectError(
    () => sql`DELETE FROM public.payment_sales WHERE id = ${saleAId}::uuid`,
    "append-only",
    "payment_sales DELETE is blocked",
  )

  // single argument call must resolve to the canonical function (sale written,
  // not the removed stale overload)
  await sql`SELECT set_config('request.jwt.claims', '', true)`

  // -------------------------------------------------------------------------
  console.log("\n== B. CUSTOMER CANCEL + REFUND SETTLES WALLET CLAWBACK ==")
  const [cancelB] = await sql`SELECT public.customer_cancel_registration_and_claim_refund(${ids.pay1}::uuid, ${ids.attendee}::uuid) AS res`
  assertEq(cancelB.res.ok, true, "customer cancel accepted")
  assertEq(cancelB.res.amount, 94000, "refund due is the ticket amount (fee kept)")
  const [regB] = await sql`SELECT status, qr_code, deleted_at FROM public.registrations WHERE id = ${ids.reg1}::uuid`
  assertEq(regB.status, "cancelled", "registration cancelled")
  assert(regB.qr_code === null, "QR cleared on cancel")

  const [refundB] = await sql`SELECT public.complete_payment_refund(${ids.pay1}::uuid, TRUE, ${refunds.first}, 'processed', 94000) AS res`
  assertEq(refundB.res.wallet_debited, true, "wallet clawback debited")
  assertEq(await wallet(), 0, "wallet back to zero after refund")

  const [cbB] = await sql`SELECT * FROM public.refund_clawbacks WHERE payment_id = ${ids.pay1}::uuid`
  assertEq(cbB.state, "done", "clawback debt settled")
  assertEq(cbB.amount, 94000, "clawback amount equals organizer share")
  assertEq(cbB.sale_id, saleAId, "clawback points at the sale it reversed")

  const [hB] = await sql`SELECT * FROM public.payment_refund_history WHERE razorpay_refund_id = ${refunds.first}`
  assertEq(hB.sale_id, saleAId, "refund history linked to the reversed sale")
  assertEq(hB.organizer_clawed, 94000, "refund stores organizer clawback")
  assertEq(hB.fee_kept, 6000, "refund stores the platform fee kept")
  assertEq(hB.refund_amount, 94000, "refund stores the customer amount")

  // duplicate settlement cannot debit twice
  const [refundB2] = await sql`SELECT public.complete_payment_refund(${ids.pay1}::uuid, TRUE, ${refunds.first}, 'processed', 94000) AS res`
  assertEq(refundB2.res.already_debited, true, "duplicate settlement recognised as already debited")
  assertEq(await wallet(), 0, "duplicate settlement cannot debit again")
  assertEq((await sql`SELECT count(*)::int AS n FROM public.refund_clawbacks WHERE payment_id = ${ids.pay1}::uuid`)[0].n, 1, "no duplicate clawback row")

  let st = await statement()
  const salesSt1 = st.filter((t) => t.transaction_type === "ticket_sale")
  const refundsSt1 = st.filter((t) => t.transaction_type === "refund")
  assertEq(salesSt1.length, 1, "statement shows the single sale")
  assertEq(refundsSt1.length, 1, "statement shows the refund")
  assertEq(refundsSt1[0].money_out, 94000, "statement refund money_out is the clawback")

  // -------------------------------------------------------------------------
  console.log("\n== C. CANCEL -> REBOOK WRITES A SECOND SALE ==")
  await requote(ids.pay1, "order_C")
  const [confirmC] = await sql`SELECT public.confirm_payment(${ids.pay1}::uuid, 100000, 'INR', ${captures.saleC}) AS res`
  assertEq(confirmC.res.action, "confirmed", "rebook confirmed")
  assertEq(await wallet(), 94000, "rebook credits the wallet again")
  saleRows = await sales()
  assertEq(saleRows.length, 2, "rebook wrote a second immutable sale")
  assertEq(saleRows[1].gross_amount, 100000, "second sale captured gross")
  const saleCId = saleRows[1].id as string
  assert(saleCId !== saleAId, "the two sales are distinct rows")

  const [regC] = await sql`SELECT qr_code FROM public.registrations WHERE id = ${ids.reg1}::uuid`
  assert(regC.qr_code && regC.qr_code !== qrA, "rebook rotated the QR credential")

  st = await statement()
  assertEq(st.filter((t) => t.transaction_type === "ticket_sale").length, 2, "statement now shows BOTH sales (no undercount)")
  assertEq(
    st.filter((t) => t.transaction_type === "ticket_sale").reduce((n, t) => n + Number(t.gross_amount), 0),
    200000,
    "statement gross is the sum of every capture",
  )
  assertEq(
    st.filter((t) => t.transaction_type === "ticket_sale").reduce((n, t) => n + Number(t.money_in), 0),
    188000,
    "statement organizer money_in is the sum of every sale",
  )

  // -------------------------------------------------------------------------
  console.log("\n== D. SHORT WALLET LEAVES A DURABLE CLAWBACK DEBT ==")
  await sql`SELECT public.debit_wallet(${ids.community}::uuid, 54000, 'test_manual_hold', ${ids.event1}::uuid, NULL)`
  assertEq(await wallet(), 40000, "wallet partially drained")

  const [cancelD] = await sql`SELECT public.customer_cancel_registration_and_claim_refund(${ids.pay1}::uuid, ${ids.attendee}::uuid) AS res`
  assertEq(cancelD.res.ok, true, "second customer cancel accepted")

  const [refundD] = await sql`SELECT public.complete_payment_refund(${ids.pay1}::uuid, TRUE, ${refunds.second}, 'processed', 94000) AS res`
  assertEq(refundD.res.clawback_pending, true, "short wallet defers the clawback")
  assertEq(await wallet(), 40000, "failed clawback leaves the wallet untouched")

  const [payD] = await sql`SELECT refund_status, refund_clawback_state FROM public.payments WHERE id = ${ids.pay1}::uuid`
  assertEq(payD.refund_status, "processed", "customer refund is still processed")
  assertEq(payD.refund_clawback_state, "pending", "payment mirror records the pending debt")

  const [cbD] = await sql`SELECT * FROM public.refund_clawbacks WHERE sale_id = ${saleCId}::uuid`
  assert(cbD, "durable clawback row exists")
  assertEq(cbD.state, "pending", "durable clawback is pending")
  assertEq(cbD.amount, 94000, "durable clawback amount is from the reversed sale")

  // statement must still include the refund even though the payment row is
  // not 'refunded' and no wallet debit audit exists
  st = await statement()
  const refundsD = st.filter((t) => t.transaction_type === "refund")
  assertEq(refundsD.length, 2, "statement includes the pending-clawback refund")

  // payout reservation must see the debt
  const liability = await asUser(ids.admin, async () => {
    const [row] = await sql`SELECT public.admin_refund_liability_summary(${ids.community}::uuid, NULL) AS res`
    return row.res
  })
  assertEq(liability.clawback_pending, 94000, "liability summary reserves the pending clawback")
  assertEq(liability.clawback_pending_count, 1, "liability summary counts the pending clawback")

  const [payoutD] = await asUser(ids.admin, async () => {
    const rows = await sql`
      SELECT public.admin_record_manual_payout(${ids.community}::uuid, 100, 'UTR_LEDGER_TEST', 'IMPS', NULL, NULL) AS res
    `
    return rows
  })
  assertEq(payoutD.res.ok, false, "payout is refused while a clawback debt is reserved")
  assertEq(payoutD.res.error, "insufficient_uncommitted_balance", "payout refusal cites uncommitted balance")
  // 40,000 wallet - 94,000 reserved => 0 available (not 40,000)
  assertEq(payoutD.res.uncommitted_balance, 0, "reserved clawback reduces available payout balance to zero")

  // -------------------------------------------------------------------------
  console.log("\n== E. REBOOK CANNOT ERASE OR HIDE A PENDING CLAWBACK ==")
  await requote(ids.pay1, "order_E")
  const [payE] = await sql`SELECT refund_clawback_state FROM public.payments WHERE id = ${ids.pay1}::uuid`
  assertEq(payE.refund_clawback_state, "pending", "requote keeps the pending clawback mirror")

  const [confirmE] = await sql`SELECT public.confirm_payment(${ids.pay1}::uuid, 100000, 'INR', ${captures.saleE}) AS res`
  assertEq(confirmE.res.action, "confirmed", "third sale confirmed after requote")
  assertEq((await sales()).length, 3, "third immutable sale written")
  assertEq(await wallet(), 134000, "third sale credited on top of the retained balance")

  const [cbE] = await sql`SELECT state FROM public.refund_clawbacks WHERE id = ${cbD.id}::uuid`
  assertEq(cbE.state, "pending", "requote did not delete the durable debt")

  await expectError(
    () => sql`UPDATE public.payments SET refund_clawback_state = 'none' WHERE id = ${ids.pay1}::uuid`,
    "pending refund clawback",
    "guard trigger refuses clearing a live clawback mirror",
  )

  // retry once the wallet can cover the debt
  const [retry] = await sql`SELECT public.retry_refund_clawbacks(50) AS res`
  assertEq(retry.res.debited, 1, "retry settles exactly the pending clawback")
  assertEq(await wallet(), 40000, "retry debited the outstanding organizer share")
  const [cbAfter] = await sql`SELECT state, settled_at FROM public.refund_clawbacks WHERE id = ${cbD.id}::uuid`
  assertEq(cbAfter.state, "done", "durable debt marked done")
  assert(cbAfter.settled_at !== null, "settled timestamp recorded")
  const [payAfter] = await sql`SELECT refund_clawback_state FROM public.payments WHERE id = ${ids.pay1}::uuid`
  assertEq(payAfter.refund_clawback_state, "done", "payment mirror cleared only after settlement")
  const [retry2] = await sql`SELECT public.retry_refund_clawbacks(50) AS res`
  assertEq(retry2.res.attempted, 0, "retry is idempotent once settled")

  st = await statement()
  assertEq(st.filter((t) => t.transaction_type === "ticket_sale").length, 3, "statement shows all three sales")
  assertEq(st.filter((t) => t.transaction_type === "refund").length, 2, "statement shows both refunds")
  assertEq(
    st.filter((t) => t.transaction_type === "refund").reduce((n, t) => n + Number(t.money_out), 0),
    188000,
    "statement refund total is not reduced by the requote",
  )

  // -------------------------------------------------------------------------
  console.log("\n== F. EVENT CANCELLATION REVOKES TICKETS AND QUEUES REFUNDS ==")
  await seedRegistration(ids.reg2, ids.event2, ids.pay2, "order_G")
  const [confirmG] = await sql`SELECT public.confirm_payment(${ids.pay2}::uuid, 100000, 'INR', ${captures.saleG}) AS res`
  assertEq(confirmG.res.action, "confirmed", "event 2 sale confirmed")
  const [regG] = await sql`SELECT qr_code FROM public.registrations WHERE id = ${ids.reg2}::uuid`
  const qrG = regG.qr_code as string
  assert(qrG?.startsWith("cluvo_"), "event 2 ticket has a QR")

  const [cancelEvent] = await sql`SELECT public.cancel_event_and_enqueue_refunds(${ids.event2}::uuid, ${ids.organizer}::uuid) AS res`
  assertEq(cancelEvent.res.status, "cancelling", "event moves to cancelling")
  const [regG2] = await sql`SELECT qr_code FROM public.registrations WHERE id = ${ids.reg2}::uuid`
  assert(regG2.qr_code === null, "event cancellation cleared the QR immediately")

  const [scanOld] = await sql`SELECT * FROM public.check_in_registration(${qrG})`
  assertEq(scanOld.success, false, "revoked QR cannot check in")
  assertEq(scanOld.message, "Invalid QR code", "revoked QR is reported invalid")

  // Even if a credential survived, a cancelling event must refuse check-in.
  await sql`UPDATE public.registrations SET qr_code = ${"cluvo_forced_" + Date.now()} WHERE id = ${ids.reg2}::uuid`
  const [forcedQr] = await sql`SELECT qr_code FROM public.registrations WHERE id = ${ids.reg2}::uuid`
  const [scanForced] = await sql`SELECT * FROM public.check_in_registration(${forcedQr.qr_code})`
  assertEq(scanForced.success, false, "check-in refused while event is cancelling")
  assertEq(scanForced.message, "Event cancelled", "check-in reports the event as cancelled")
  await sql`UPDATE public.registrations SET qr_code = NULL WHERE id = ${ids.reg2}::uuid`

  const [taskG] = await sql`SELECT * FROM public.refund_task_queue WHERE payment_id = ${ids.pay2}::uuid ORDER BY created_at LIMIT 1`
  assertEq(taskG.status, "pending", "event cancellation enqueued a refund task")

  await sql`SELECT public.claim_payment_refund(${ids.pay2}::uuid, 'event_cancellation', 94000)`
  const [refundG] = await sql`SELECT public.complete_payment_refund(${ids.pay2}::uuid, TRUE, ${refunds.event}, 'processed', 94000) AS res`
  assertEq(refundG.res.wallet_debited, true, "event refund clawback debited")
  assertEq(await wallet(), 40000, "event refund removed the organizer share")

  // A payment capture that arrives after cancellation must not book.
  await seedRegistration(ids.reg3, ids.event2, ids.pay3, "order_H", ids.attendee2)
  const [lateConfirm] = await sql`SELECT public.confirm_payment(${ids.pay3}::uuid, 100000, 'INR', ${"pay_late_" + Date.now()}) AS res`
  assertEq(lateConfirm.res.reason, "event_cancellation", "a capture for a cancelling event is refused")
  const [lateSale] = await sql`SELECT count(*)::int AS n FROM public.payment_sales WHERE payment_id = ${ids.pay3}::uuid`
  assertEq(lateSale.n, 0, "no sale is recorded for a refused capture")

  // -------------------------------------------------------------------------
  console.log("\n== G. STATEMENTS RECONCILE SALES, REFUNDS AND PAYOUTS ==")
  st = await statement()
  const finalSales = st.filter((t) => t.transaction_type === "ticket_sale")
  const finalRefunds = st.filter((t) => t.transaction_type === "refund")
  assertEq(finalSales.length, 4, "four captures are visible (A, C, E, G)")
  assertEq(finalRefunds.length, 3, "three refunds are visible (B, D, G)")
  assertEq(
    finalSales.reduce((n, t) => n + Number(t.gross_amount), 0),
    400000,
    "gross reconciles to every capture",
  )
  assertEq(
    finalRefunds.reduce((n, t) => n + Number(t.money_out), 0),
    282000,
    "refund total reconciles to every organizer clawback",
  )
  assertEq(
    finalSales.reduce((n, t) => n + Number(t.money_in), 0) -
      finalRefunds.reduce((n, t) => n + Number(t.money_out), 0),
    94000,
    "net organizer ticket balance reconciles to every capture minus every refund",
  )

  const event1Statement = await statement(ids.event1)
  assertEq(
    event1Statement.filter((t) => t.transaction_type === "ticket_sale").length,
    3,
    "event filter only returns that event's sales",
  )

  const organizerStatement = await asUser(ids.organizer, async () => {
    const [row] = await sql`SELECT public.get_organizer_financial_statement(${ids.community}::uuid, NULL) AS data`
    return (row.data ?? []) as Array<Record<string, unknown>>
  })
  assertEq(
    organizerStatement.filter((t) => t.transaction_type === "ticket_sale").length,
    4,
    "organizer statement sees the same immutable sales",
  )

  // -------------------------------------------------------------------------
  console.log("\n== H. RLS / PRIVILEGE POSTURE ==")
  const tableGrants = await sql`
    SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
    FROM information_schema.role_table_grants
    WHERE table_name IN ('payment_sales', 'refund_clawbacks')
      AND grantee IN ('anon', 'authenticated')
    GROUP BY table_name, grantee
  `
  for (const g of tableGrants) {
    assertEq(g.privs, "SELECT", `${g.table_name} ${g.grantee} may only SELECT`)
  }

  assertEq((await sql`SELECT count(*)::int AS n FROM public.refund_clawbacks WHERE amount <= 0`)[0].n, 0,
    "no zero/negative clawback rows exist")

  // -------------------------------------------------------------------------
  console.log("\n== I. ADMIN PROVIDER-REFUND ADOPTION WRITES DURABLE DEBT ==")
  await seedRegistration(ids.reg4, ids.event3, ids.pay4, "order_I", ids.attendee2)
  await sql`SELECT public.confirm_payment(${ids.pay4}::uuid, 100000, 'INR', ${"pay_I_" + Date.now()})`
  const [saleI] = await sql`SELECT id FROM public.payment_sales WHERE payment_id = ${ids.pay4}::uuid`

  // Drain the wallet so the clawback must be deferred.
  await sql`SELECT public.debit_wallet(${ids.community}::uuid, 134000, 'test_drain', ${ids.event3}::uuid, NULL)`
  assertEq(await wallet(), 0, "wallet drained before adoption")

  const [cancelI] = await sql`SELECT public.cancel_event_and_enqueue_refunds(${ids.event3}::uuid, ${ids.organizer}::uuid) AS res`
  assertEq(cancelI.res.status, "cancelling", "event 3 cancellation started")
  const [taskI] = await sql`SELECT id FROM public.refund_task_queue WHERE payment_id = ${ids.pay4}::uuid ORDER BY created_at LIMIT 1`
  const adoptRefundId = `rfnd_ADOPT${Date.now()}`
  const [adopt] = await sql`
    SELECT public.admin_adopt_provider_refund(${taskI.id}::uuid, ${ids.admin}::uuid, ${adoptRefundId}, 'verified provider refund') AS res
  `
  assertEq(adopt.res.clawback_state, "pending", "adoption defers a short wallet clawback")

  const [adoptCb] = await sql`SELECT * FROM public.refund_clawbacks WHERE payment_id = ${ids.pay4}::uuid`
  assertEq(adoptCb.state, "pending", "adoption wrote a durable pending clawback")
  assertEq(adoptCb.amount, 94000, "adoption debt equals the organizer share")
  assertEq(adoptCb.sale_id, saleI.id, "adoption debt is linked to the reversed sale")

  const [adoptHistory] = await sql`SELECT sale_id, organizer_clawed, fee_kept FROM public.payment_refund_history WHERE razorpay_refund_id = ${adoptRefundId}`
  assertEq(adoptHistory.sale_id, saleI.id, "adoption history is linked to the sale")
  assertEq(adoptHistory.organizer_clawed, 94000, "adoption history stores the clawback")
  assertEq(adoptHistory.fee_kept, 6000, "adoption history stores the fee kept")

  const liabilityI = await asUser(ids.admin, async () => {
    const [row] = await sql`SELECT public.admin_refund_liability_summary(${ids.community}::uuid, ${ids.event3}::uuid) AS res`
    return row.res
  })
  assertEq(liabilityI.clawback_pending, 94000, "liability summary sees the adopted debt")

  await sql`SELECT public.credit_wallet(${ids.community}::uuid, 94000, ${ids.event3}::uuid, NULL)`
  const [retryI] = await sql`SELECT public.retry_refund_clawbacks(50) AS res`
  assertEq(retryI.res.debited, 1, "adopted debt is recovered by the retry job")
  assertEq((await sql`SELECT state FROM public.refund_clawbacks WHERE payment_id = ${ids.pay4}::uuid`)[0].state, "done",
    "adopted debt settled to done")

  // -------------------------------------------------------------------------
  console.log("\n== J. OFFLINE MANUAL SETTLEMENT WRITES DURABLE DEBT ==")
  await seedRegistration(ids.reg5, ids.event4, ids.pay5, "order_J")
  await sql`SELECT public.confirm_payment(${ids.pay5}::uuid, 100000, 'INR', ${"pay_J_" + Date.now()})`
  const [saleJ] = await sql`SELECT id FROM public.payment_sales WHERE payment_id = ${ids.pay5}::uuid`

  await sql`SELECT public.debit_wallet(${ids.community}::uuid, 94000, 'test_drain2', ${ids.event4}::uuid, NULL)`
  assertEq(await wallet(), 0, "wallet drained before offline settlement")

  const [cancelJ] = await sql`SELECT public.cancel_event_and_enqueue_refunds(${ids.event4}::uuid, ${ids.organizer}::uuid) AS res`
  assertEq(cancelJ.res.status, "cancelling", "event 4 cancellation started")
  const [taskJ] = await sql`SELECT id FROM public.refund_task_queue WHERE payment_id = ${ids.pay5}::uuid ORDER BY created_at LIMIT 1`
  const evidence = {
    settlement_method: "bank_transfer",
    reference_number: "OFFLINE123456",
    notes: "Verified against the bank statement on the settlement date.",
  }
  const [settleJ] = await sql`
    SELECT public.admin_manual_settlement(${taskJ.id}::uuid, ${ids.admin}::uuid, ${sql.json(evidence)}) AS res
  `
  assertEq(settleJ.res.clawback_state, "pending", "offline settlement defers a short wallet clawback")

  const [settleCb] = await sql`SELECT * FROM public.refund_clawbacks WHERE payment_id = ${ids.pay5}::uuid`
  assertEq(settleCb.state, "pending", "offline settlement wrote a durable pending clawback")
  assertEq(settleCb.amount, 94000, "offline settlement debt equals the organizer share")
  assertEq(settleCb.sale_id, saleJ.id, "offline settlement debt is linked to the sale")

  const [settleHistory] = await sql`SELECT sale_id, organizer_clawed FROM public.payment_refund_history WHERE payment_id = ${ids.pay5}::uuid`
  assertEq(settleHistory.sale_id, saleJ.id, "offline settlement history is linked to the sale")
  assertEq(settleHistory.organizer_clawed, 94000, "offline settlement history stores the clawback")

  await sql`SELECT public.credit_wallet(${ids.community}::uuid, 94000, ${ids.event4}::uuid, NULL)`
  const [retryJ] = await sql`SELECT public.retry_refund_clawbacks(50) AS res`
  assertEq(retryJ.res.debited, 1, "offline settlement debt is recovered by the retry job")
  assertEq((await sql`SELECT state FROM public.refund_clawbacks WHERE payment_id = ${ids.pay5}::uuid`)[0].state, "done",
    "offline settlement debt settled to done")
  assertEq((await sql`SELECT refund_clawback_state FROM public.payments WHERE id = ${ids.pay5}::uuid`)[0].refund_clawback_state,
    "done", "offline settlement mirror cleared after recovery")

  // -------------------------------------------------------------------------
  console.log("\n== K. MULTIPLE PARTIAL REFUNDS ON ONE SALE ==")
  await seedRegistration(ids.reg6, ids.event5, ids.pay6, "order_K")
  await sql`SELECT public.confirm_payment(${ids.pay6}::uuid, 100000, 'INR', ${"pay_K_" + Date.now()})`
  const [saleK] = await sql`SELECT id FROM public.payment_sales WHERE payment_id = ${ids.pay6}::uuid`

  await sql`SELECT public.debit_wallet(${ids.community}::uuid, 94000, 'test_drain3', ${ids.event5}::uuid, NULL)`
  assertEq(await wallet(), 0, "wallet drained before partial refunds")

  const part1 = `rfnd_PART1${Date.now()}`
  const part2 = `rfnd_PART2${Date.now()}`
  await sql`SELECT public.claim_payment_refund(${ids.pay6}::uuid, 'partial_refund_1', 40000)`
  const [settle1] = await sql`SELECT public.settle_payment_refund(${ids.pay6}::uuid, ${part1}, 'processed', 40000) AS res`
  assertEq(settle1.res.clawback_pending, true, "first partial refund defers its clawback")
  assertEq(await wallet(), 0, "first partial clawback left the wallet untouched")

  // Second partial refund settles successfully while the first debt is open.
  await sql`SELECT public.credit_wallet(${ids.community}::uuid, 54000, ${ids.event5}::uuid, NULL)`
  const [settle2] = await sql`SELECT public.settle_payment_refund(${ids.pay6}::uuid, ${part2}, 'processed', 54000) AS res`
  assertEq(settle2.res.wallet_debited, true, "second partial clawback debited without aborting")
  assertEq(await wallet(), 0, "second partial clawback removed its share")

  const partRows = await sql`SELECT refund_status, sale_id, organizer_clawed FROM public.payment_refund_history WHERE payment_id = ${ids.pay6}::uuid ORDER BY created_at`
  assertEq(partRows.length, 2, "both partial refunds are recorded as separate ledger rows")
  assert(partRows.every((r) => r.sale_id === saleK.id), "both partial refunds point at the same sale")
  assertEq(partRows.reduce((n, r) => n + Number(r.organizer_clawed), 0), 94000,
    "partial clawbacks sum to the organizer share, never more")

  const [mirrorK] = await sql`SELECT refund_clawback_state FROM public.payments WHERE id = ${ids.pay6}::uuid`
  assertEq(mirrorK.refund_clawback_state, "pending", "aggregate mirror stays pending while any debt remains")

  const partDebts = await sql`SELECT state, amount FROM public.refund_clawbacks WHERE payment_id = ${ids.pay6}::uuid ORDER BY created_at`
  assertEq(partDebts.map((d) => d.state), ["pending", "done"], "each partial has its own durable debt row")
  assertEq(partDebts[0].amount, 40000, "first debt amount is the first partial")
  assertEq(partDebts[1].amount, 54000, "second debt amount is the second partial")

  await sql`SELECT public.credit_wallet(${ids.community}::uuid, 40000, ${ids.event5}::uuid, NULL)`
  const [retryK] = await sql`SELECT public.retry_refund_clawbacks(50) AS res`
  assertEq(retryK.res.debited, 1, "retry recovers the outstanding partial")
  assertEq((await sql`SELECT refund_clawback_state FROM public.payments WHERE id = ${ids.pay6}::uuid`)[0].refund_clawback_state,
    "done", "mirror clears once every partial debt is settled")
}

try {
  await main()
} catch (err) {
  failures.push(err instanceof Error ? err.stack ?? err.message : String(err))
} finally {
  try {
    await sql.unsafe("ROLLBACK")
  } catch { /* ignore */ }
  await sql.end({ timeout: 5 })
}

console.log("\n============================================================")
if (failures.length > 0) {
  console.error("FAILED")
  for (const f of failures) console.error(f)
  Deno.exit(1)
}
console.log(`ALL CHECKS PASSED (${passed} assertions)`)
