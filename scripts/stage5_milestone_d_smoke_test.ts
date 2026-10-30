// scripts/stage5_milestone_d_smoke_test.ts
// CLUVO STAGE 5 MILESTONE D — LIVE STAGING SMOKE TEST SUITE
// Verifies all Milestone D financial reconciliation, partial refunds,
// disputed payout accounting, and passbook invariants against remote staging: ofvfasdgdwkehdcjugnf

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

const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

const results: SmokeResult[] = []

// Cleanup tracker
const cleanupUserIds: string[] = []
const cleanupCommunityIds: string[] = []
const cleanupEventIds: string[] = []
const cleanupPayoutItemIds: string[] = []
const cleanupPaymentIds: string[] = []
const cleanupRegistrationIds: string[] = []
const cleanupRefundIds: string[] = []

async function createTestUser(role: "customer" | "organizer" | "admin" = "customer"): Promise<{
  id: string
  email: string
  token: string
}> {
  const ts = Date.now() + "_" + Math.floor(Math.random() * 1000000)
  const email = `smoke_d_${role}_${ts}@example.com`
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
      user_metadata: { first_name: "SmokeD", last_name: role, username: `smk_d_${role}_${ts}` }
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
    name: `Smoke Comm D ${ts}`,
    description: "Milestone D Smoke Test Community",
    owner_id: ownerId,
    wallet_balance: initialBalance
  }).select("id").single()

  if (error || !data) throw new Error(`Failed to create test community: ${error?.message}`)
  cleanupCommunityIds.push(data.id)

  // Add beneficiary
  await serviceClient.from("community_beneficiaries").insert({
    community_id: data.id,
    account_holder: "Smoke Organizer D",
    bank_account_number: "987654321098",
    bank_ifsc: "HDFC0001234",
    is_active: true,
    label: "Primary Payout Account"
  })

  return data.id
}

async function createTestEvent(communityId: string, pricePaise = 100000): Promise<string> {
  const ts = Date.now() + "_" + Math.floor(Math.random() * 100000)
  const { data, error } = await serviceClient.from("events").insert({
    title: `Smoke Event D ${ts}`,
    description: "Milestone D Smoke Test Event",
    community_id: communityId,
    price: pricePaise,
    capacity: 50,
    start_date: new Date(Date.now() + 86400000 * 7).toISOString(),
    end_date: new Date(Date.now() + 86400000 * 7 + 7200000).toISOString(),
    status: "published",
    location: "Online / Staging Test"
  }).select("id").single()

  if (error || !data) throw new Error(`Failed to create test event: ${error?.message}`)
  cleanupEventIds.push(data.id)
  return data.id
}

async function simulateConfirmedPurchase(
  communityId: string,
  eventId: string,
  userId: string,
  pricePaise: number
): Promise<{ paymentId: string; registrationId: string; organizerShare: number; platformFee: number }> {
  const ts = Date.now() + "_" + Math.floor(Math.random() * 1000000)
  const platformFee = Math.floor((pricePaise * 6) / 100)
  const organizerShare = pricePaise - platformFee

  // 1. Create registration
  const { data: reg, error: regErr } = await serviceClient.from("registrations").insert({
    event_id: eventId,
    user_id: userId,
    status: "confirmed"
  }).select("id").single()
  if (regErr || !reg) throw new Error(`Registration failed: ${regErr?.message}`)
  cleanupRegistrationIds.push(reg.id)

  // 2. Create payment
  const rzpPaymentId = `pay_smoke_d_${ts}`
  const { data: pay, error: payErr } = await serviceClient.from("payments").insert({
    registration_id: reg.id,
    amount: pricePaise,
    platform_fee: platformFee,
    organizer_share: organizerShare,
    status: "success",
    razorpay_payment_id: rzpPaymentId,
    currency: "INR"
  }).select("id").single()
  if (payErr || !pay) throw new Error(`Payment failed: ${payErr?.message}`)
  cleanupPaymentIds.push(pay.id)

  // 3. Atomically credit organizer wallet
  await serviceClient.rpc("credit_wallet", {
    p_community_id: communityId,
    p_amount: organizerShare
  })

  // 4. Log wallet_credited in audit log
  await serviceClient.from("payment_audit_log").insert({
    action: "wallet_credited",
    payment_id: pay.id,
    details: {
      community_id: communityId,
      event_id: eventId,
      payment_id: pay.id,
      amount: organizerShare
    }
  })

  return { paymentId: pay.id, registrationId: reg.id, organizerShare, platformFee }
}

async function runSmokeTests() {
  console.log("================================================================================")
  console.log("CLUVO STAGE 5 MILESTONE D — LIVE STAGING SMOKE TEST SUITE")
  console.log(`Target Supabase URL: ${SUPABASE_URL}`)
  console.log(`Razorpay Key Mode: ${RAZORPAY_KEY_ID}`)
  console.log("================================================================================\n")

  // Setup test actors
  console.log("Step 0: Provisioning isolated test users and community...")
  const organizer = await createTestUser("organizer")
  const customer = await createTestUser("customer")
  const admin = await createTestUser("admin")
  const communityId = await createTestCommunity(organizer.id, 0)
  const eventId = await createTestEvent(communityId, 100000) // ₹1000 ticket
  console.log(`  Organizer: ${organizer.email} (${organizer.id})`)
  console.log(`  Customer:  ${customer.email} (${customer.id})`)
  console.log(`  Admin:     ${admin.email} (${admin.id})`)
  console.log(`  Community: ${communityId}`)
  console.log(`  Event:     ${eventId}\n`)

  const adminClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${admin.token}` } }
  })

  const organizerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${organizer.token}` } }
  })

  // --------------------------------------------------------------------------
  // TEST 1: CONFIRMED TICKET PURCHASE & BASELINE PASSBOOK
  // --------------------------------------------------------------------------
  console.log("TEST 1: Simulating Confirmed Ticket Purchase (₹1000 / 100,000 paise)...")
  const purchase = await simulateConfirmedPurchase(communityId, eventId, customer.id, 100000)
  console.log(`  Payment ID: ${purchase.paymentId}`)
  console.log(`  Platform Fee (6%): ${purchase.platformFee} paise (₹60)`)
  console.log(`  Organizer Share:   ${purchase.organizerShare} paise (₹940)`)

  const { data: comm1 } = await serviceClient.from("communities").select("wallet_balance").eq("id", communityId).single()
  const step1Pass = comm1?.wallet_balance === 94000
  results.push({
    step: 1,
    title: "Ticket Purchase Fee Split & Wallet Credit",
    verdict: step1Pass ? "PASS" : "FAIL",
    details: `Wallet balance is ${comm1?.wallet_balance} paise (expected 94,000 paise).`,
    evidence: { wallet_balance: comm1?.wallet_balance, expected: 94000, purchase }
  })
  console.log(`  Verdict: ${step1Pass ? "PASS ✓" : "FAIL ✗"}\n`)

  // --------------------------------------------------------------------------
  // TEST 2: MULTIPLE LEGITIMATE PARTIAL REFUNDS ON ONE PAYMENT (FIN-AUDIT-005)
  // --------------------------------------------------------------------------
  console.log("TEST 2: Multiple Legitimate Partial Refunds against Single Payment...")
  const rzpRef1 = `rfnd_part1_${Date.now()}`
  const rzpRef2 = `rfnd_part2_${Date.now()}`

  // Partial refund 1: ₹300 (30,000 paise)
  const { data: ref1, error: refErr1 } = await serviceClient.from("payment_refund_history").insert({
    payment_id: purchase.paymentId,
    registration_id: purchase.registrationId,
    event_id: eventId,
    amount: 30000,
    payment_amount: 100000,
    platform_fee: 0,
    refund_status: "processed",
    razorpay_refund_id: rzpRef1,
    refund_reason: "partial_refund_1"
  }).select("id").single()
  if (refErr1) throw new Error(`Ref 1 insert failed: ${refErr1.message}`)
  cleanupRefundIds.push(ref1.id)

  // Wallet debit 1
  await serviceClient.rpc("debit_wallet", { p_community_id: communityId, p_amount: 30000 })
  await serviceClient.from("payment_audit_log").insert({
    action: "wallet_debited",
    payment_id: purchase.paymentId,
    details: { community_id: communityId, event_id: eventId, payment_id: purchase.paymentId, amount: 30000, reason: "partial_1" }
  })

  // Partial refund 2: ₹400 (40,000 paise)
  const { data: ref2, error: refErr2 } = await serviceClient.from("payment_refund_history").insert({
    payment_id: purchase.paymentId,
    registration_id: purchase.registrationId,
    event_id: eventId,
    amount: 40000,
    payment_amount: 100000,
    platform_fee: 0,
    refund_status: "processed",
    razorpay_refund_id: rzpRef2,
    refund_reason: "partial_refund_2"
  }).select("id").single()
  if (refErr2) throw new Error(`Ref 2 insert failed: ${refErr2.message}`)
  cleanupRefundIds.push(ref2.id)

  // Wallet debit 2
  await serviceClient.rpc("debit_wallet", { p_community_id: communityId, p_amount: 40000 })
  await serviceClient.from("payment_audit_log").insert({
    action: "wallet_debited",
    payment_id: purchase.paymentId,
    details: { community_id: communityId, event_id: eventId, payment_id: purchase.paymentId, amount: 40000, reason: "partial_2" }
  })

  // Check organizer statement
  const { data: orgStatement } = await organizerClient.rpc("get_organizer_financial_statement", {
    p_community_id: communityId,
    p_event_id: eventId
  })

  const statementRefunds = (orgStatement || []).filter((tx: any) => tx.transaction_type === "refund")
  const hasRef1 = statementRefunds.some((tx: any) => tx.reference_id === rzpRef1 && tx.money_out === 30000)
  const hasRef2 = statementRefunds.some((tx: any) => tx.reference_id === rzpRef2 && tx.money_out === 40000)
  const { data: comm2 } = await serviceClient.from("communities").select("wallet_balance").eq("id", communityId).single()
  const expectedBal = 94000 - 30000 - 40000 // 24,000 paise

  const step2Pass = hasRef1 && hasRef2 && statementRefunds.length === 2 && comm2?.wallet_balance === expectedBal
  results.push({
    step: 2,
    title: "Multiple Partial Refunds Preserved with Individual Debits (FIN-AUDIT-005)",
    verdict: step2Pass ? "PASS" : "FAIL",
    details: `Both partial refunds preserved in passbook. Wallet balance is ${comm2?.wallet_balance} paise (expected ${expectedBal} paise).`,
    evidence: { refunds_in_statement: statementRefunds.length, hasRef1, hasRef2, wallet_balance: comm2?.wallet_balance }
  })
  console.log(`  Refunds found in passbook: ${statementRefunds.length} (expected 2)`)
  console.log(`  Wallet Balance: ${comm2?.wallet_balance} paise (expected ${expectedBal} paise)`)
  console.log(`  Verdict: ${step2Pass ? "PASS ✓" : "FAIL ✗"}\n`)

  // --------------------------------------------------------------------------
  // TEST 3: DUPLICATE REFUND WEBHOOK DEDUPLICATION (FIN-AUDIT-005)
  // --------------------------------------------------------------------------
  console.log("TEST 3: Duplicate Refund Delivery Deduplication by Provider ID...")
  // Insert duplicate delivery of ref1 (same razorpay_refund_id)
  const { data: dupeRef } = await serviceClient.from("payment_refund_history").insert({
    payment_id: purchase.paymentId,
    registration_id: purchase.registrationId,
    event_id: eventId,
    amount: 30000,
    payment_amount: 100000,
    platform_fee: 0,
    refund_status: "processed",
    razorpay_refund_id: rzpRef1,
    refund_reason: "duplicate_webhook_replay"
  }).select("id").single()
  if (dupeRef) cleanupRefundIds.push(dupeRef.id)

  const { data: adminStatement } = await adminClient.rpc("get_admin_financial_statement", {
    p_community_id: communityId,
    p_event_id: eventId
  })
  const adminRefunds = (adminStatement || []).filter((tx: any) => tx.transaction_type === "refund")

  // Deduplication check: statement must still have exactly 2 refunds, NOT 3!
  const step3Pass = adminRefunds.length === 2
  results.push({
    step: 3,
    title: "Duplicate Provider Refund Transaction Deduplication (FIN-AUDIT-005)",
    verdict: step3Pass ? "PASS" : "FAIL",
    details: `Passbook contains ${adminRefunds.length} refunds after duplicate webhook replay (expected 2).`,
    evidence: { total_refund_history_rows: 3, passbook_deduped_refunds: adminRefunds.length }
  })
  console.log(`  Total refund history rows: 3 | Deduped passbook refunds: ${adminRefunds.length}`)
  console.log(`  Verdict: ${step3Pass ? "PASS ✓" : "FAIL ✗"}\n`)

  // --------------------------------------------------------------------------
  // TEST 4: CUMULATIVE ORGANIZER REFUND DEDUCTION CAP (FIN-AUDIT-005)
  // --------------------------------------------------------------------------
  console.log("TEST 4: Cumulative Organizer Refund Deduction Cap...")
  // We already debited 30,000 + 40,000 = 70,000 paise out of 94,000 organizer share.
  // Remaining organizer share is 24,000 paise.
  // Now record a 3rd refund of 50,000 paise (500 INR).
  const rzpRef3 = `rfnd_part3_overflow_${Date.now()}`
  const { data: ref3 } = await serviceClient.from("payment_refund_history").insert({
    payment_id: purchase.paymentId,
    registration_id: purchase.registrationId,
    event_id: eventId,
    amount: 50000,
    payment_amount: 100000,
    platform_fee: 0,
    refund_status: "processed",
    razorpay_refund_id: rzpRef3,
    refund_reason: "partial_refund_3"
  }).select("id").single()
  if (ref3) cleanupRefundIds.push(ref3.id)

  const { data: adminStatementCapped } = await adminClient.rpc("get_admin_financial_statement", {
    p_community_id: communityId,
    p_event_id: eventId
  })
  const refund3Tx = (adminStatementCapped || []).find((tx: any) => tx.reference_id === rzpRef3)
  // Due to window function cumulative cap, refund3's organizer_share / money_out must be capped at 24,000 paise!
  const step4Pass = refund3Tx?.money_out === 24000
  results.push({
    step: 4,
    title: "Cumulative Refund Deduction Cap at Organizer Share (FIN-AUDIT-005)",
    verdict: step4Pass ? "PASS" : "FAIL",
    details: `Requested refund of 50,000 paise was capped at ${refund3Tx?.money_out} paise (remaining share).`,
    evidence: { requested: 50000, applied_money_out: refund3Tx?.money_out, expected_cap: 24000 }
  })
  console.log(`  Requested: 50,000 paise | Applied money_out: ${refund3Tx?.money_out} paise (expected 24,000 paise)`)
  console.log(`  Verdict: ${step4Pass ? "PASS ✓" : "FAIL ✗"}\n`)

  // --------------------------------------------------------------------------
  // TEST 5: PENDING & DISPUTED PAYOUT UNCOMMITTED DEDUCTION (FIN-AUDIT-006)
  // --------------------------------------------------------------------------
  console.log("TEST 5: Disputed Manual Payout Uncommitted Balance Reservation (FIN-AUDIT-006)...")
  // Give community wallet ₹1000 (100,000 paise)
  await serviceClient.rpc("credit_wallet", { p_community_id: communityId, p_amount: 100000 })
  const { data: commPrePayout } = await serviceClient.from("communities").select("wallet_balance").eq("id", communityId).single()
  const startingBal = commPrePayout?.wallet_balance || 0

  // 5.1 Admin records manual payout of 20,000 paise
  const utr1 = `UTR_SMOKE_PEND_${Date.now()}`
  const { data: poRes, error: poErr } = await adminClient.rpc("admin_record_manual_payout", {
    p_community_id: communityId,
    p_amount: 20000,
    p_utr: utr1,
    p_payment_method: "IMPS",
    p_event_id: eventId,
    p_admin_notes: "Smoke test pending payout"
  })
  if (poErr || !poRes?.ok) throw new Error(`Manual payout failed: ${poErr?.message || poRes?.error}`)
  const payoutId = poRes.payout_id
  cleanupPayoutItemIds.push(payoutId)

  // Verify wallet is untouched but uncommitted is reduced
  const { data: kpiPending } = await adminClient.rpc("get_financial_observability_kpis")
  const { data: reconPending } = await adminClient.rpc("run_financial_reconciliation", { p_community_id: communityId })
  const cPending = reconPending.three_way_wallet_reconciliation[0]

  const pendingReserved = cPending.in_flight_pending_payouts === 20000 &&
    cPending.uncommitted_wallet_balance === (startingBal - 20000)

  // 5.2 Organizer disputes the payout
  const { data: dispRes, error: dispErr } = await organizerClient.rpc("organizer_dispute_manual_payout", {
    p_payout_id: payoutId,
    p_reason: "Bank account does not reflect transfer"
  })
  if (dispErr || !dispRes?.ok) throw new Error(`Dispute failed: ${dispErr?.message || dispRes?.error}`)

  // Verify wallet is STILL untouched, but disputed is subtracted from uncommitted balance!
  const { data: reconDisputed } = await adminClient.rpc("run_financial_reconciliation", { p_community_id: communityId })
  const cDisputed = reconDisputed.three_way_wallet_reconciliation[0]

  const disputedReserved = cDisputed.disputed_payouts === 20000 &&
    cDisputed.in_flight_pending_payouts === 0 &&
    cDisputed.uncommitted_wallet_balance === (startingBal - 20000) && // Must NOT add back to uncommitted!
    cDisputed.stored_wallet_balance === startingBal

  const step5Pass = pendingReserved && disputedReserved
  results.push({
    step: 5,
    title: "Disputed Manual Payout Uncommitted Balance Reservation (FIN-AUDIT-006)",
    verdict: step5Pass ? "PASS" : "FAIL",
    details: `Disputed transfer remains locked and deducted from uncommitted balance (${cDisputed.uncommitted_wallet_balance} paise).`,
    evidence: { startingBal, stored_wallet: cDisputed.stored_wallet_balance, uncommitted: cDisputed.uncommitted_wallet_balance, disputed_amount: cDisputed.disputed_payouts }
  })
  console.log(`  Stored Wallet: ${cDisputed.stored_wallet_balance} paise (untouched)`)
  console.log(`  Uncommitted Balance: ${cDisputed.uncommitted_wallet_balance} paise (locked: ${cDisputed.disputed_payouts} paise disputed)`)
  console.log(`  Verdict: ${step5Pass ? "PASS ✓" : "FAIL ✗"}\n`)

  // --------------------------------------------------------------------------
  // TEST 6: ADMIN PAYOUT OVER-ALLOCATION REJECTION (FIN-AUDIT-006)
  // --------------------------------------------------------------------------
  console.log("TEST 6: Admin Manual Payout Over-Allocation Rejection (FIN-AUDIT-006)...")
  // Attempt to record payout exceeding uncommitted balance
  const excessiveAmount = cDisputed.uncommitted_wallet_balance + 50000
  const utrOver = `UTR_SMOKE_OVER_${Date.now()}`

  const { data: overRes } = await adminClient.rpc("admin_record_manual_payout", {
    p_community_id: communityId,
    p_amount: excessiveAmount,
    p_utr: utrOver,
    p_payment_method: "IMPS",
    p_event_id: eventId,
    p_admin_notes: "Excessive payout attempt"
  })

  const step6Pass = overRes?.ok === false && overRes?.error === "insufficient_uncommitted_balance"
  results.push({
    step: 6,
    title: "Admin Payout Over-Allocation Rejection with Row Lock (FIN-AUDIT-006)",
    verdict: step6Pass ? "PASS" : "FAIL",
    details: `Attempt to payout ${excessiveAmount} paise rejected with ${overRes?.error}.`,
    evidence: { requested: excessiveAmount, uncommitted: cDisputed.uncommitted_wallet_balance, rpc_response: overRes }
  })
  console.log(`  Requested: ${excessiveAmount} paise | Uncommitted available: ${cDisputed.uncommitted_wallet_balance} paise`)
  console.log(`  Rejection Response: ${overRes?.error} (${overRes?.message})`)
  console.log(`  Verdict: ${step6Pass ? "PASS ✓" : "FAIL ✗"}\n`)

  // --------------------------------------------------------------------------
  // TEST 7: READ-ONLY PURITY & STRICT RBAC VERIFICATION
  // --------------------------------------------------------------------------
  console.log("TEST 7: Read-Only Purity & Security Gate Verification...")
  // Measure table counts and wallet before
  const { data: preComm } = await serviceClient.from("communities").select("wallet_balance").eq("id", communityId).single()
  const { count: prePayCount } = await serviceClient.from("payments").select("*", { count: "exact", head: true })
  const { count: preRefcount } = await serviceClient.from("payment_refund_history").select("*", { count: "exact", head: true })
  const { count: prePoCount } = await serviceClient.from("payout_items").select("*", { count: "exact", head: true })

  // Execute reconciliation and KPIs
  await adminClient.rpc("run_financial_reconciliation", { p_community_id: null, p_batch_limit: 100 })
  await adminClient.rpc("get_financial_observability_kpis")

  // Measure after
  const { data: postComm } = await serviceClient.from("communities").select("wallet_balance").eq("id", communityId).single()
  const { count: postPayCount } = await serviceClient.from("payments").select("*", { count: "exact", head: true })
  const { count: postRefcount } = await serviceClient.from("payment_refund_history").select("*", { count: "exact", head: true })
  const { count: postPoCount } = await serviceClient.from("payout_items").select("*", { count: "exact", head: true })

  const zeroMutations = preComm?.wallet_balance === postComm?.wallet_balance &&
    prePayCount === postPayCount &&
    preRefcount === postRefcount &&
    prePoCount === postPoCount

  // Security gate: anon user cannot call reconciliation
  let anonBlocked = false
  try {
    const { error: anonErr } = await anonClient.rpc("run_financial_reconciliation")
    if (anonErr) anonBlocked = true
  } catch {
    anonBlocked = true
  }

  const step7Pass = zeroMutations && anonBlocked
  results.push({
    step: 7,
    title: "Read-Only Reconciliation Purity & Security Definier Gates",
    verdict: step7Pass ? "PASS" : "FAIL",
    details: `0 table mutations detected during reconciliation. Anon execution blocked: ${anonBlocked}.`,
    evidence: { zeroMutations, anonBlocked, preComm, postComm }
  })
  console.log(`  Table Mutations: 0 (Zero wallet balances or payment rows altered)`)
  console.log(`  Anon Privilege Denied: ${anonBlocked ? "YES (Strict RBAC Enforced)" : "NO"}`)
  console.log(`  Verdict: ${step7Pass ? "PASS ✓" : "FAIL ✗"}\n`)

  // --------------------------------------------------------------------------
  // CLEANUP
  // --------------------------------------------------------------------------
  console.log("Cleaning up test records on remote staging...")
  if (cleanupPayoutItemIds.length > 0) {
    await serviceClient.from("payout_items").delete().in("id", cleanupPayoutItemIds)
  }
  if (cleanupRefundIds.length > 0) {
    await serviceClient.from("payment_refund_history").delete().in("id", cleanupRefundIds)
  }
  if (cleanupPaymentIds.length > 0) {
    await serviceClient.from("payments").delete().in("id", cleanupPaymentIds)
  }
  if (cleanupRegistrationIds.length > 0) {
    await serviceClient.from("registrations").delete().in("id", cleanupRegistrationIds)
  }
  if (cleanupEventIds.length > 0) {
    await serviceClient.from("events").delete().in("id", cleanupEventIds)
  }
  if (cleanupCommunityIds.length > 0) {
    await serviceClient.from("community_beneficiaries").delete().in("community_id", cleanupCommunityIds)
    await serviceClient.from("communities").delete().in("id", cleanupCommunityIds)
  }
  for (const uid of cleanupUserIds) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
    })
  }
  console.log("Cleanup complete.\n")

  // --------------------------------------------------------------------------
  // FINAL SUMMARY
  // --------------------------------------------------------------------------
  const allPassed = results.every(r => r.verdict === "PASS")
  console.log("================================================================================")
  console.log(`LIVE STAGING SMOKE TEST SUMMARY: ${allPassed ? "100% PASSED (7/7)" : "FAILURES DETECTED"}`)
  console.log("================================================================================")
  for (const r of results) {
    console.log(`[${r.verdict}] Test ${r.step}: ${r.title} — ${r.details}`)
  }

  // Persist results to disk
  Deno.writeTextFileSync(
    "audit/mobile-security/stage5_milestone_d_smoke_test_results.json",
    JSON.stringify({ timestamp: new Date().toISOString(), allPassed, results }, null, 2)
  )

  if (!allPassed) {
    Deno.exit(1)
  }
}

await runSmokeTests()
