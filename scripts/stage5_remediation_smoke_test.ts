// scripts/stage5_remediation_smoke_test.ts
// CLUVO STAGE 5 REMEDIATION — LIVE STAGING SMOKE TEST SUITE
// Verifies all three remediated findings against staging project ofvfasdgdwkehdcjugnf

import { createClient } from "npm:@supabase/supabase-js@2"
import { createHmac } from "node:crypto"

interface SmokeResult {
  step: number
  title: string
  verdict: "PASS" | "FAIL"
  details: string
  evidence: Record<string, unknown>
}

// 1. Safeguard & Environment Loading
function loadEnv(): Record<string, string> {
  const text = Deno.readTextFileSync("supabase/.env")
  const env: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx !== -1) {
      env[trimmed.substring(0, idx)] = trimmed.substring(idx + 1)
    }
  }
  return env
}

const env = loadEnv()
const SUPABASE_URL = env.SUPABASE_URL
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const RAZORPAY_KEY_ID = env.RAZORPAY_KEY_ID
const RAZORPAY_WEBHOOK_SECRET = env.RAZORPAY_WEBHOOK_SECRET

// Absolute guardrails
if (!SUPABASE_URL.includes("ofvfasdgdwkehdcjugnf")) {
  throw new Error(`CRITICAL HALT: Target URL ${SUPABASE_URL} is NOT the staging project (ofvfasdgdwkehdcjugnf)!`)
}
if (SUPABASE_URL.includes("vdxspyumkvwawmqwfkzr")) {
  throw new Error(`CRITICAL HALT: Production URL detected! Aborting immediately.`)
}
if (!RAZORPAY_KEY_ID.startsWith("rzp_test_")) {
  throw new Error(`CRITICAL HALT: Live Razorpay key detected! Aborting immediately.`)
}

const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

const results: SmokeResult[] = []

function computeHmacSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex")
}

// Cleanup tracker
const cleanupUserIds: string[] = []
const cleanupCommunityIds: string[] = []
const cleanupEventIds: string[] = []
const cleanupPayoutItemIds: string[] = []
const cleanupWebhookIds: string[] = []

async function createTestUser(role: "customer" | "organizer" | "admin" = "customer"): Promise<{
  id: string
  email: string
  token: string
}> {
  const ts = Date.now() + "_" + Math.floor(Math.random() * 1000000)
  const email = `smoke5_${role}_${ts}@example.com`
  const password = "SmokePassword123!"

  const createResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      app_metadata: { cluvo_provisioned: true, provider: "email" },
      user_metadata: { first_name: "Smoke", last_name: role, username: `smk_${role}_${ts}` }
    })
  })

  if (!createResp.ok) {
    throw new Error(`Failed to create test user: ${createResp.status} ${await createResp.text()}`)
  }
  const userData = await createResp.json()
  const uid = userData.id
  cleanupUserIds.push(uid)

  if (role === "admin") {
    await serviceClient.from("profiles").update({ is_admin: true }).eq("id", uid)
  }

  // Insert consent
  await serviceClient.from("consent_log").insert({
    user_id: uid,
    consent_version: "2026-10-22",
    source: "smoke_test"
  })

  // Sign in to obtain session JWT
  const loginResp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  })

  if (!loginResp.ok) {
    throw new Error(`Failed to log in test user: ${loginResp.status} ${await loginResp.text()}`)
  }
  const loginData = await loginResp.json()
  return { id: uid, email, token: loginData.access_token }
}

async function createTestCommunity(ownerId: string, initialBalance = 0): Promise<string> {
  const ts = Date.now() + "_" + Math.floor(Math.random() * 100000)
  const { data, error } = await serviceClient.from("communities").insert({
    name: `Smoke Comm ${ts}`,
    description: "Stage 5 Smoke Test Community",
    owner_id: ownerId,
    commission_percent: 6.0,
    wallet_balance: initialBalance
  }).select("id").single()

  if (error) throw error
  cleanupCommunityIds.push(data.id)
  return data.id
}

async function createTestEvent(communityId: string, ownerId: string, capacity = 10, price = 50000): Promise<string> {
  const ts = Date.now() + "_" + Math.floor(Math.random() * 100000)
  const { data, error } = await serviceClient.from("events").insert({
    community_id: communityId,
    title: `Smoke Event ${ts}`,
    description: "Stage 5 Smoke Test Event",
    capacity,
    price,
    booked_count: 0,
    status: "published",
    created_by: ownerId,
    start_date: new Date(Date.now() + 86400000 * 5).toISOString(),
    end_date: new Date(Date.now() + 86400000 * 5 + 7200000).toISOString()
  }).select("id").single()

  if (error) throw error
  cleanupEventIds.push(data.id)
  return data.id
}

console.log("================================================================================")
console.log("CLUVO STAGE 5 REMEDIATION — LIVE STAGING SMOKE TEST")
console.log(`Supabase URL:    ${SUPABASE_URL}`)
console.log(`Razorpay Mode:   ${RAZORPAY_KEY_ID.startsWith("rzp_test_") ? "TEST MODE (rzp_test_...)" : "INVALID"}`)
console.log("================================================================================\n")

try {
  // ============================================================================
  // TEST 1: Razorpay payment.captured webhook returns HTTP 200 and confirms payment
  // (Verifies PAY-REL-006 fix: processed_webhooks.processed_at column)
  // ============================================================================
  console.log("--- TEST 1: Razorpay payment.captured webhook confirms payment ---")
  const org1 = await createTestUser("organizer")
  const cust1 = await createTestUser("customer")
  const comm1Id = await createTestCommunity(org1.id, 0)
  const ev1Id = await createTestEvent(comm1Id, org1.id, 10, 50000) // ₹500

  // 1. Reserve ticket capacity
  const { data: reserveData, error: reserveErr } = await serviceClient.rpc("reserve_ticket_capacity", {
    p_event_id: ev1Id,
    p_user_id: cust1.id
  })
  if (reserveErr || !reserveData?.ok) {
    throw new Error(`reserve_ticket_capacity failed: ${reserveErr?.message || JSON.stringify(reserveData)}`)
  }
  const reg1Id = reserveData.registration_id

  // 2. Insert pending payment row
  const rzpOrderId1 = `order_smk_${Date.now()}_${Math.floor(Math.random() * 10000)}`
  const { data: payRow1, error: payInsertErr } = await serviceClient.from("payments").insert({
    registration_id: reg1Id,
    razorpay_order_id: rzpOrderId1,
    amount: 50000,
    currency: "INR",
    platform_fee: 3000,
    organizer_share: 47000,
    status: "pending"
  }).select("id, status, amount").single()

  if (payInsertErr) throw payInsertErr

  // 3. Deliver signed payment.captured webhook
  const rzpPaymentId1 = `pay_smk_${Date.now()}`
  const webhookBody1 = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: rzpPaymentId1,
          order_id: rzpOrderId1,
          amount: 50000,
          currency: "INR",
          status: "captured",
          amount_refunded: 0
        }
      }
    }
  })
  const webhookSig1 = computeHmacSignature(webhookBody1, RAZORPAY_WEBHOOK_SECRET)
  const expectedWebhookId = `${rzpPaymentId1}_payment.captured`.replaceAll("_", "")
  cleanupWebhookIds.push(expectedWebhookId)

  const whResp1 = await fetch(`${SUPABASE_URL}/functions/v1/verify-payment-webhook`, {
    method: "POST",
    headers: {
      "x-razorpay-signature": webhookSig1,
      "Content-Type": "application/json"
    },
    body: webhookBody1
  })
  const whText1 = await whResp1.text()

  // Verify in database: payment status, registration status, processed_webhooks row
  const { data: updatedPay1 } = await serviceClient.from("payments").select("id, status, razorpay_payment_id").eq("id", payRow1.id).single()
  const { data: updatedReg1 } = await serviceClient.from("registrations").select("id, status, qr_code").eq("id", reg1Id).single()
  const { data: whRow1 } = await serviceClient.from("processed_webhooks").select("id, provider, event_type, processed_at").eq("id", expectedWebhookId).maybeSingle()

  const test1Pass = whResp1.status === 200 &&
    whText1 === "OK" &&
    updatedPay1?.status === "success" &&
    updatedPay1?.razorpay_payment_id === rzpPaymentId1 &&
    updatedReg1?.status === "confirmed" &&
    Boolean(updatedReg1?.qr_code) &&
    Boolean(whRow1?.processed_at)

  results.push({
    step: 1,
    title: "Razorpay payment.captured webhook returns HTTP 200 and confirms payment",
    verdict: test1Pass ? "PASS" : "FAIL",
    details: test1Pass
      ? `HTTP 200 'OK' received. Payment ${payRow1.id} set to 'success', registration ${reg1Id} set to 'confirmed' with QR code. processed_webhooks recorded with processed_at=${whRow1?.processed_at}.`
      : `Failed: HTTP ${whResp1.status} (${whText1}), pay status: ${updatedPay1?.status}, reg status: ${updatedReg1?.status}`,
    evidence: {
      httpStatus: whResp1.status,
      responseBody: whText1,
      paymentId: payRow1.id,
      razorpayOrderId: rzpOrderId1,
      razorpayPaymentId: updatedPay1?.razorpay_payment_id,
      paymentStatus: updatedPay1?.status,
      registrationStatus: updatedReg1?.status,
      hasQrCode: Boolean(updatedReg1?.qr_code),
      processedWebhookRecord: whRow1
    }
  })
  console.log(`${test1Pass ? "✅ PASS" : "❌ FAIL"} Test 1: Webhook confirmation (HTTP ${whResp1.status}: ${whText1})`)

  // ============================================================================
  // TEST 2: Duplicate webhook is safely ignored
  // (Verifies PAY-REL-002 idempotency and safe already_processed return)
  // ============================================================================
  console.log("\n--- TEST 2: Duplicate webhook is safely ignored ---")
  const whResp2 = await fetch(`${SUPABASE_URL}/functions/v1/verify-payment-webhook`, {
    method: "POST",
    headers: {
      "x-razorpay-signature": webhookSig1,
      "Content-Type": "application/json"
    },
    body: webhookBody1
  })
  const whText2 = await whResp2.text()

  // Verify payment and registration remained untouched
  const { data: checkPay2 } = await serviceClient.from("payments").select("id, status, razorpay_payment_id").eq("id", payRow1.id).single()
  const { data: checkReg2 } = await serviceClient.from("registrations").select("id, status").eq("id", reg1Id).single()

  const test2Pass = whResp2.status === 200 &&
    whText2 === "Already processed" &&
    checkPay2?.status === "success" &&
    checkReg2?.status === "confirmed"

  results.push({
    step: 2,
    title: "Duplicate webhook is safely ignored",
    verdict: test2Pass ? "PASS" : "FAIL",
    details: test2Pass
      ? `HTTP 200 'Already processed' received on redelivery. Payment status preserved as 'success', registration preserved as 'confirmed'. Zero side-effects.`
      : `Failed: HTTP ${whResp2.status} (${whText2})`,
    evidence: {
      httpStatus: whResp2.status,
      responseBody: whText2,
      paymentStatus: checkPay2?.status,
      registrationStatus: checkReg2?.status
    }
  })
  console.log(`${test2Pass ? "✅ PASS" : "❌ FAIL"} Test 2: Duplicate webhook rejection (HTTP ${whResp2.status}: ${whText2})`)

  // ============================================================================
  // TEST 3: Duplicate manual payout for the same community/event/UTR is rejected
  // (Verifies FIN-REL-008 scoped compound unique index uq_payout_items_active_transfer)
  // ============================================================================
  console.log("\n--- TEST 3: Duplicate manual payout for same community/event/UTR is rejected ---")
  const adminUser = await createTestUser("admin")
  const adminClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${adminUser.token}` } }
  })

  const org2 = await createTestUser("organizer")
  const comm2Id = await createTestCommunity(org2.id, 200000) // ₹2,000 balance
  const ev2AId = await createTestEvent(comm2Id, org2.id, 20, 50000)

  // Insert active beneficiary
  const { data: beneRow, error: beneErr } = await serviceClient.from("community_beneficiaries").insert({
    community_id: comm2Id,
    cashfree_beneficiary_id: `bene_${Date.now()}`,
    account_holder: "Smoke Organizer",
    bank_account_number: "919876543210",
    bank_ifsc: "HDFC0001234",
    is_active: true
  }).select("id").single()
  if (beneErr) throw beneErr

  const testUtr1 = `UTR_SMK_${Date.now()}_ABC`

  // First manual payout recording
  const { data: payoutRes1, error: payoutErr1 } = await adminClient.rpc("admin_record_manual_payout", {
    p_community_id: comm2Id,
    p_event_id: ev2AId,
    p_amount: 30000, // ₹300
    p_utr: testUtr1,
    p_payment_method: "IMPS",
    p_admin_notes: "Initial offline transfer for event 2A"
  })

  if (payoutErr1) throw payoutErr1
  cleanupPayoutItemIds.push(payoutRes1.payout_id)

  // Second manual payout recording: SAME community, SAME event, SAME UTR (with whitespace / lowercase to test normalization)
  const { data: dupPayoutRes, error: dupPayoutErr } = await adminClient.rpc("admin_record_manual_payout", {
    p_community_id: comm2Id,
    p_event_id: ev2AId,
    p_amount: 30000,
    p_utr: `  ${testUtr1.toLowerCase()}  `,
    p_payment_method: "IMPS",
    p_admin_notes: "Duplicate attempt for same event"
  })

  // Verify only 1 record exists in payout_items with this UTR
  const { data: existingPayouts } = await serviceClient.from("payout_items").select("id, status, utr, amount").eq("community_id", comm2Id).eq("event_id", ev2AId)

  const test3Pass = payoutRes1?.ok === true &&
    dupPayoutRes?.ok === false &&
    dupPayoutRes?.error === "duplicate_payout_utr" &&
    existingPayouts?.length === 1

  results.push({
    step: 3,
    title: "Duplicate manual payout for the same community/event/UTR is rejected",
    verdict: test3Pass ? "PASS" : "FAIL",
    details: test3Pass
      ? `First payout succeeded (id: ${payoutRes1?.payout_id}). Duplicate attempt cleanly rejected with error='duplicate_payout_utr'. Only 1 payout row exists in DB.`
      : `Failed: first=${JSON.stringify(payoutRes1)}, dup=${JSON.stringify(dupPayoutRes)}, err=${dupPayoutErr?.message}`,
    evidence: {
      initialPayout: payoutRes1,
      duplicateAttemptResult: dupPayoutRes,
      databasePayoutRowCount: existingPayouts?.length,
      storedUtr: existingPayouts?.[0]?.utr
    }
  })
  console.log(`${test3Pass ? "✅ PASS" : "❌ FAIL"} Test 3: Duplicate payout rejected (${dupPayoutRes?.error})`)

  // ============================================================================
  // TEST 4: One UTR across different events is accepted
  // (Verifies multiple-event settlement attribution using a single bank transfer UTR)
  // ============================================================================
  console.log("\n--- TEST 4: One UTR across different events is accepted ---")
  const ev2BId = await createTestEvent(comm2Id, org2.id, 20, 50000)

  // Record manual payout for Event 2B using the SAME UTR testUtr1 (multi-event transfer)
  const { data: multiEventPayoutRes, error: multiEventPayoutErr } = await adminClient.rpc("admin_record_manual_payout", {
    p_community_id: comm2Id,
    p_event_id: ev2BId,
    p_amount: 20000, // ₹200 for event 2B
    p_utr: testUtr1,
    p_payment_method: "IMPS",
    p_admin_notes: "Multi-event combined offline transfer (portion for event 2B)"
  })

  if (multiEventPayoutErr) throw multiEventPayoutErr
  cleanupPayoutItemIds.push(multiEventPayoutRes.payout_id)

  const { data: allUtrPayouts } = await serviceClient.from("payout_items").select("id, event_id, amount, status, utr").eq("community_id", comm2Id).eq("utr", testUtr1)

  const test4Pass = multiEventPayoutRes?.ok === true &&
    multiEventPayoutRes?.status === "pending_confirmation" &&
    allUtrPayouts?.length === 2 &&
    allUtrPayouts.some(p => p.event_id === ev2AId) &&
    allUtrPayouts.some(p => p.event_id === ev2BId)

  results.push({
    step: 4,
    title: "One UTR across different events is accepted",
    verdict: test4Pass ? "PASS" : "FAIL",
    details: test4Pass
      ? `Single UTR '${testUtr1}' successfully attributed across Event A (id: ${payoutRes1?.payout_id}) and Event B (id: ${multiEventPayoutRes?.payout_id}). Both active in 'pending_confirmation'.`
      : `Failed: multiEventRes=${JSON.stringify(multiEventPayoutRes)}, rows=${JSON.stringify(allUtrPayouts)}`,
    evidence: {
      utr: testUtr1,
      eventAPayoutId: payoutRes1?.payout_id,
      eventBPayoutId: multiEventPayoutRes?.payout_id,
      databaseRows: allUtrPayouts
    }
  })
  console.log(`${test4Pass ? "✅ PASS" : "❌ FAIL"} Test 4: Multi-event UTR accepted (2 rows for UTR ${testUtr1})`)

  // ============================================================================
  // TEST 5: Organizer acknowledgement deducts wallet exactly once
  // (Verifies organizer_confirm_manual_payout status check & atomic wallet debit)
  // ============================================================================
  console.log("\n--- TEST 5: Organizer acknowledgement deducts wallet exactly once ---")
  const orgClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${org2.token}` } }
  })

  // Target payout: payoutRes1 (30,000 paise = ₹300)
  const targetPayoutId = payoutRes1.payout_id

  // Verify wallet balance BEFORE organizer confirmation: should still be 200,000 paise (₹2,000)
  const { data: commBefore } = await serviceClient.from("communities").select("wallet_balance").eq("id", comm2Id).single()
  const initialBalance = commBefore?.wallet_balance ?? 0

  // 1. First confirmation call by organizer
  const { data: confirmRes1, error: confirmErr1 } = await orgClient.rpc("organizer_confirm_manual_payout", {
    p_payout_id: targetPayoutId
  })
  if (confirmErr1) throw confirmErr1

  // Check balance after first confirmation
  const { data: commAfter1 } = await serviceClient.from("communities").select("wallet_balance").eq("id", comm2Id).single()
  const { data: payoutItemAfter1 } = await serviceClient.from("payout_items").select("status, confirmed_by_user, confirmed_at").eq("id", targetPayoutId).single()

  // 2. Second confirmation call on SAME payout by organizer (re-acknowledgement attack / double tap)
  const { data: confirmRes2, error: confirmErr2 } = await orgClient.rpc("organizer_confirm_manual_payout", {
    p_payout_id: targetPayoutId
  })

  // Check balance after second confirmation attempt
  const { data: commAfter2 } = await serviceClient.from("communities").select("wallet_balance").eq("id", comm2Id).single()

  const test5Pass = initialBalance === 200000 &&
    confirmRes1?.ok === true &&
    confirmRes1?.status === "success" &&
    payoutItemAfter1?.status === "success" &&
    commAfter1?.wallet_balance === 170000 && // 200000 - 30000 = 170000
    confirmRes2?.ok === false &&
    confirmRes2?.error === "Payout is not in pending confirmation state." &&
    commAfter2?.wallet_balance === 170000 // Wallet NOT deducted twice

  results.push({
    step: 5,
    title: "Organizer acknowledgement deducts wallet exactly once",
    verdict: test5Pass ? "PASS" : "FAIL",
    details: test5Pass
      ? `First acknowledgement deducted ₹300 (wallet: 200,000 -> 170,000 paise). Second acknowledgement was rejected with 'Payout is not in pending confirmation state.', leaving wallet balance intact at 170,000 paise.`
      : `Failed: initial=${initialBalance}, after1=${commAfter1?.wallet_balance}, after2=${commAfter2?.wallet_balance}, res2=${JSON.stringify(confirmRes2)}`,
    evidence: {
      initialWalletBalance: initialBalance,
      afterFirstConfirmWalletBalance: commAfter1?.wallet_balance,
      afterSecondConfirmWalletBalance: commAfter2?.wallet_balance,
      firstConfirmResult: confirmRes1,
      secondConfirmResult: confirmRes2,
      payoutItemFinalStatus: payoutItemAfter1?.status
    }
  })
  console.log(`${test5Pass ? "✅ PASS" : "❌ FAIL"} Test 5: Wallet deducted once (200,000 -> 170,000, 2nd call rejected: ${confirmRes2?.error})`)

  // ============================================================================
  // TEST 6: Booking hold reuse returns reused_hold: true
  // (Verifies PAY-CONC-007 fix: active hold reuse outside payments lookup block)
  // ============================================================================
  console.log("\n--- TEST 6: Booking hold reuse returns reused_hold: true ---")
  const org3 = await createTestUser("organizer")
  const cust3 = await createTestUser("customer")
  const comm3Id = await createTestCommunity(org3.id, 0)
  const ev3Id = await createTestEvent(comm3Id, org3.id, 5, 45000)

  // 1. Initial reservation: should create hold with reused_hold = false
  const { data: hold1Data, error: hold1Err } = await serviceClient.rpc("reserve_ticket_capacity", {
    p_event_id: ev3Id,
    p_user_id: cust3.id
  })
  if (hold1Err) throw hold1Err

  // 2. Immediate second call BEFORE any payment row is created: should reuse hold with reused_hold = true
  const { data: hold2Data, error: hold2Err } = await serviceClient.rpc("reserve_ticket_capacity", {
    p_event_id: ev3Id,
    p_user_id: cust3.id
  })
  if (hold2Err) throw hold2Err

  // 3. Now insert pending payment row for this registration
  const rzpOrderId3 = `order_smk3_${Date.now()}`
  await serviceClient.from("payments").insert({
    registration_id: hold1Data.registration_id,
    razorpay_order_id: rzpOrderId3,
    amount: 45000,
    currency: "INR",
    status: "pending"
  })

  // 4. Third call AFTER payment row exists: should ALSO reuse hold with reused_hold = true
  const { data: hold3Data, error: hold3Err } = await serviceClient.rpc("reserve_ticket_capacity", {
    p_event_id: ev3Id,
    p_user_id: cust3.id
  })
  if (hold3Err) throw hold3Err

  const test6Pass = hold1Data?.ok === true &&
    hold1Data?.reused_hold === false &&
    hold2Data?.ok === true &&
    hold2Data?.reused_hold === true &&
    hold2Data?.registration_id === hold1Data?.registration_id &&
    hold3Data?.ok === true &&
    hold3Data?.reused_hold === true &&
    hold3Data?.registration_id === hold1Data?.registration_id

  results.push({
    step: 6,
    title: "Booking hold reuse returns reused_hold: true",
    verdict: test6Pass ? "PASS" : "FAIL",
    details: test6Pass
      ? `Initial reservation created registration ${hold1Data.registration_id} (reused_hold: false). Sequential tap before payment returned same registration with reused_hold: true. Sequential tap after payment returned same registration with reused_hold: true.`
      : `Failed: hold1=${JSON.stringify(hold1Data)}, hold2=${JSON.stringify(hold2Data)}, hold3=${JSON.stringify(hold3Data)}`,
    evidence: {
      initialCall: hold1Data,
      secondCallBeforePayment: hold2Data,
      thirdCallAfterPayment: hold3Data
    }
  })
  console.log(`${test6Pass ? "✅ PASS" : "❌ FAIL"} Test 6: Hold reuse verified (Call 1 reused=false, Call 2 reused=true, Call 3 reused=true)`)

} catch (err) {
  console.error("FATAL ERROR IN SMOKE TEST RUN:", err)
} finally {
  console.log("\n--- TEARDOWN TEST FIXTURES ---")
  // Cleanup test entities safely
  for (const pid of cleanupPayoutItemIds) {
    await serviceClient.from("payout_items").delete().eq("id", pid)
  }
  for (const wid of cleanupWebhookIds) {
    await serviceClient.from("processed_webhooks").delete().like("id", `${wid}%`)
  }
  for (const eid of cleanupEventIds) {
    await serviceClient.from("registrations").delete().eq("event_id", eid)
    await serviceClient.from("events").delete().eq("id", eid)
  }
  for (const cid of cleanupCommunityIds) {
    await serviceClient.from("community_beneficiaries").delete().eq("community_id", cid)
    await serviceClient.from("communities").delete().eq("id", cid)
  }
  for (const uid of cleanupUserIds) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
        method: "DELETE",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      })
    } catch (_) { /* ignore */ }
  }
  console.log("Teardown complete.")
}

console.log("\n================================================================================")
console.log("SMOKE TEST SUMMARY")
console.log("================================================================================")
let allPassed = true
for (const res of results) {
  const icon = res.verdict === "PASS" ? "✅" : "❌"
  if (res.verdict !== "PASS") allPassed = false
  console.log(`${icon} [TEST ${res.step}] ${res.title}: ${res.verdict}`)
  console.log(`   Details: ${res.details}`)
  console.log(`   Evidence: ${JSON.stringify(res.evidence, null, 2)}\n`)
}

console.log(`FINAL RESULT: ${allPassed ? "ALL 6 SMOKE TESTS PASSED" : "ONE OR MORE TESTS FAILED"}`)
Deno.writeTextFileSync(
  "audit/mobile-security/stage5_smoke_test_results.json",
  JSON.stringify({ timestamp: new Date().toISOString(), allPassed, results }, null, 2)
)
if (!allPassed) {
  Deno.exit(1)
}

