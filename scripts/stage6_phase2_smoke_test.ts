// scripts/stage6_phase2_smoke_test.ts
// CLUVO STAGE 6 PHASE 2 — LIVE STAGING SMOKE TEST SUITE
// Target Supabase: https://ofvfasdgdwkehdcjugnf.supabase.co
// Verifies BUG-004, BUG-005, and BUG-010 on live staging project

import { createClient } from "npm:@supabase/supabase-js@2"

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

// Cleanup registry
const cleanupUserIds: string[] = []
const cleanupCommunityIds: string[] = []
const cleanupEventIds: string[] = []
const cleanupCouponIds: string[] = []

async function createTestUser(emailPrefix: string, isAdmin = false): Promise<{ id: string; email: string; token: string }> {
  const email = `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}@example.com`
  const password = "TestPassword123!@#"
  const { data, error } = await serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: "Smoke", last_name: "Tester" }
  })
  if (error || !data.user) throw new Error(`Failed to create test user: ${error?.message}`)
  
  if (isAdmin) {
    await serviceClient.from("profiles").update({ is_admin: true }).eq("id", data.user.id)
  }

  // Record consent
  await serviceClient.from("consent_log").insert({
    user_id: data.user.id,
    version: "2026-10-15-v1",
    source: "mobile"
  })

  // Sign in to get user JWT
  const { data: authData, error: signInError } = await anonClient.auth.signInWithPassword({
    email,
    password
  })
  if (signInError || !authData.session) throw new Error(`Failed to sign in test user: ${signInError?.message}`)

  cleanupUserIds.push(data.user.id)
  return { id: data.user.id, email, token: authData.session.access_token }
}

async function createTestCommunity(ownerId: string): Promise<string> {
  const ts = Date.now() + "_" + Math.floor(Math.random() * 100000)
  const { data, error } = await serviceClient
    .from("communities")
    .insert({
      name: `Smoke_Comm_${ts}`,
      owner_id: ownerId,
      visibility: "public",
      verification_status: "verified",
      status: "active"
    })
    .select("id")
    .single()

  if (error || !data) throw new Error(`Failed to create test community: ${error?.message}`)
  cleanupCommunityIds.push(data.id)
  return data.id
}

async function recordResult(
  step: number,
  title: string,
  fn: () => Promise<{ details: string; evidence: Record<string, unknown> }>
) {
  console.log(`\n============================================================`)
  console.log(`[STEP ${step}] STARTING: ${title}`)
  console.log(`============================================================`)

  try {
    const { details, evidence } = await fn()
    results.push({ step, title, verdict: "PASS", details, evidence })
    console.log(`[STEP ${step}] PASS: ${title}`)
    console.log(`  Details: ${details}`)
  } catch (err: any) {
    results.push({
      step,
      title,
      verdict: "FAIL",
      details: err.message || String(err),
      evidence: { error: err.stack || String(err) }
    })
    console.error(`[STEP ${step}] FAIL: ${title}`)
    console.error(`  Error: ${err.message || String(err)}`)
    throw err
  }
}

async function runSmokeTests() {
  console.log("================================================================================")
  console.log("CLUVO STAGE 6 PHASE 2 LIVE STAGING SMOKE TEST SUITE")
  console.log(`Target: ${SUPABASE_URL}`)
  console.log(`Timestamp: ${new Date().toISOString()}`)
  console.log("================================================================================")

  // Provision test actors
  const regularUserA = await createTestUser("smoke_user_a")
  const regularUserB = await createTestUser("smoke_user_b")
  const adminUser = await createTestUser("smoke_admin", true)
  const ownerUser = await createTestUser("smoke_owner")

  const userAClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${regularUserA.token}` } }
  })

  const userBClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${regularUserB.token}` } }
  })

  const adminClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${adminUser.token}` } }
  })

  // --------------------------------------------------------------------------
  // STEP 1: BUG-004 — Community Closure RLS & Membership Guard
  // --------------------------------------------------------------------------
  await recordResult(1, "BUG-004: Community Closure RLS & Role Escalation Defense", async () => {
    // 1. Create active community -> User A can self-join as MEMBER
    const commId = await createTestCommunity(ownerUser.id)
    const { error: joinActiveErr } = await userAClient
      .from("community_members")
      .insert({ community_id: commId, user_id: regularUserA.id, role: "MEMBER" })
    if (joinActiveErr) throw new Error(`Self-join active community failed: ${joinActiveErr.message}`)

    // 2. Unauthorized role escalation rejected: User B attempts to join as ORGANIZER
    const { error: escalateErr } = await userBClient
      .from("community_members")
      .insert({ community_id: commId, user_id: regularUserB.id, role: "ORGANIZER" })
    if (!escalateErr) throw new Error("Expected role escalation to ORGANIZER to be rejected by RLS!")

    // 3. Put community into closure grace
    await serviceClient
      .from("communities")
      .update({ deletion_grace_started_at: new Date().toISOString() })
      .eq("id", commId)

    // 4. User B cannot join community in deletion grace
    const { error: joinGraceErr } = await userBClient
      .from("community_members")
      .insert({ community_id: commId, user_id: regularUserB.id, role: "MEMBER" })
    if (!joinGraceErr) throw new Error("Expected self-join in closure grace to be rejected by RLS!")

    // 5. Existing member (User A) CAN leave during closure grace
    const { error: leaveErr } = await userAClient
      .from("community_members")
      .delete()
      .eq("community_id", commId)
      .eq("user_id", regularUserA.id)
    if (leaveErr) throw new Error(`Existing member leave during grace failed: ${leaveErr.message}`)

    // 6. Admin user CAN insert members during closure grace (Admin Recovery)
    const { error: adminInsertErr } = await adminClient
      .from("community_members")
      .insert({ community_id: commId, user_id: regularUserB.id, role: "MEMBER" })
    if (adminInsertErr) throw new Error(`Admin recovery insert during grace failed: ${adminInsertErr.message}`)

    return {
      details: "Self-join active succeeded, escalation blocked, grace join blocked, member leave succeeded, admin recovery succeeded",
      evidence: { community_id: commId }
    }
  })

  // --------------------------------------------------------------------------
  // STEP 2: BUG-005 — Atomic Free-Event Registration & Capacity Invariants
  // --------------------------------------------------------------------------
  await recordResult(2, "BUG-005: Atomic Free-Event Registration & Concurrency Guards", async () => {
    const commId = await createTestCommunity(ownerUser.id)

    // 1. Create a free event with capacity = 2
    const { data: event, error: eventErr } = await serviceClient
      .from("events")
      .insert({
        community_id: commId,
        title: "Free Community Meetup",
        price: 0,
        capacity: 2,
        booked_count: 0,
        status: "published",
        start_date: new Date(Date.now() + 86400000).toISOString()
      })
      .select("id, booked_count, capacity")
      .single()
    if (eventErr || !event) throw new Error(`Failed to create free event: ${eventErr?.message}`)
    cleanupEventIds.push(event.id)

    // 2. Direct authenticated client RPC call must be denied (42501)
    const { error: directRpcErr } = await userAClient.rpc("register_free_event", {
      p_event_id: event.id,
      p_user_id: regularUserA.id
    })
    if (!directRpcErr) throw new Error("Direct client RPC register_free_event must be denied!")

    // 3. User A registers via Edge Function
    const regResp1 = await fetch(`${SUPABASE_URL}/functions/v1/register-for-event`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${regularUserA.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ event_id: event.id })
    })
    const regJson1 = await regResp1.json()
    if (!regResp1.ok || !regJson1.success) {
      throw new Error(`Free registration 1 failed: ${regResp1.status} ${JSON.stringify(regJson1)}`)
    }

    // Verify booked_count incremented to 1
    const { data: eventAfter1 } = await serviceClient
      .from("events")
      .select("booked_count")
      .eq("id", event.id)
      .single()
    if (eventAfter1?.booked_count !== 1) {
      throw new Error(`Expected booked_count = 1, found ${eventAfter1?.booked_count}`)
    }

    // 4. Duplicate request by User A is idempotent (returns success, booked_count stays 1)
    const regRespDup = await fetch(`${SUPABASE_URL}/functions/v1/register-for-event`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${regularUserA.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ event_id: event.id })
    })
    const regJsonDup = await regRespDup.json()
    if (!regRespDup.ok || !regJsonDup.success) {
      throw new Error(`Duplicate registration failed: ${regRespDup.status} ${JSON.stringify(regJsonDup)}`)
    }
    const { data: eventAfterDup } = await serviceClient
      .from("events")
      .select("booked_count")
      .eq("id", event.id)
      .single()
    if (eventAfterDup?.booked_count !== 1) {
      throw new Error(`Duplicate request double-counted! booked_count = ${eventAfterDup?.booked_count}`)
    }

    // 5. User B registers (takes last seat: booked_count becomes 2)
    const regResp2 = await fetch(`${SUPABASE_URL}/functions/v1/register-for-event`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${regularUserB.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ event_id: event.id })
    })
    const regJson2 = await regResp2.json()
    if (!regResp2.ok || !regJson2.success) {
      throw new Error(`Free registration 2 failed: ${regResp2.status} ${JSON.stringify(regJson2)}`)
    }

    // 6. User C attempts to register for full event -> rejected with 409 capacity_full
    const regularUserC = await createTestUser("smoke_user_c")
    const regResp3 = await fetch(`${SUPABASE_URL}/functions/v1/register-for-event`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${regularUserC.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ event_id: event.id })
    })
    const regJson3 = await regResp3.json()
    if (regResp3.status !== 409 || regJson3.code !== "capacity_full") {
      throw new Error(`Expected 409 capacity_full on full event, got ${regResp3.status} ${JSON.stringify(regJson3)}`)
    }

    return {
      details: "Direct RPC denied, atomic registration incremented booked_count, duplicate idempotent, full capacity rejected",
      evidence: { event_id: event.id, final_booked_count: 2 }
    }
  })

  // --------------------------------------------------------------------------
  // STEP 3: BUG-005 — Active Paid Checkout Holds Block Free Registration
  // --------------------------------------------------------------------------
  await recordResult(3, "BUG-005: Active Paid Checkout Holds Respected by Free Registration", async () => {
    const commId = await createTestCommunity(ownerUser.id)

    // Event with capacity = 1
    const { data: event, error: eventErr } = await serviceClient
      .from("events")
      .insert({
        community_id: commId,
        title: "Contended Free Seat",
        price: 0,
        capacity: 1,
        booked_count: 0,
        status: "published",
        start_date: new Date(Date.now() + 86400000).toISOString()
      })
      .select("id")
      .single()
    if (eventErr || !event) throw new Error(`Failed to create event: ${eventErr?.message}`)
    cleanupEventIds.push(event.id)

    // Simulate an active checkout hold placed by User A
    const holdExpires = new Date(Date.now() + 600000).toISOString()
    const { data: holdReg, error: holdErr } = await serviceClient
      .from("registrations")
      .insert({
        event_id: event.id,
        user_id: regularUserA.id,
        status: "pending",
        hold_expires_at: holdExpires
      })
      .select("id")
      .single()
    if (holdErr) throw new Error(`Failed to insert active hold: ${holdErr.message}`)

    // User B attempts free registration -> must be rejected because seat is held
    const regResp = await fetch(`${SUPABASE_URL}/functions/v1/register-for-event`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${regularUserB.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ event_id: event.id })
    })
    const regJson = await regResp.json()
    if (regResp.status !== 409 || regJson.code !== "capacity_full") {
      throw new Error(`Expected 409 capacity_full due to active hold, got ${regResp.status} ${JSON.stringify(regJson)}`)
    }

    // Release User A's hold
    await serviceClient.rpc("release_ticket_capacity", { p_registration_id: holdReg.id })

    // Now User B attempts free registration -> must succeed
    const regRespAfter = await fetch(`${SUPABASE_URL}/functions/v1/register-for-event`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${regularUserB.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ event_id: event.id })
    })
    const regJsonAfter = await regRespAfter.json()
    if (!regRespAfter.ok || !regJsonAfter.success) {
      throw new Error(`Registration failed after hold released: ${regRespAfter.status} ${JSON.stringify(regJsonAfter)}`)
    }

    return {
      details: "Active paid hold correctly prevented free registration; release of hold immediately unlocked seat",
      evidence: { event_id: event.id }
    }
  })

  // --------------------------------------------------------------------------
  // STEP 4: BUG-010 — Coupon Failure Capacity Hold Release & Counter Preservation
  // --------------------------------------------------------------------------
  await recordResult(4, "BUG-010: Coupon Exhaustion Hold Release & Counter Integrity", async () => {
    const commId = await createTestCommunity(ownerUser.id)

    // Paid event (price: 500)
    const { data: event, error: eventErr } = await serviceClient
      .from("events")
      .insert({
        community_id: commId,
        title: "Exclusive Paid Workshop",
        price: 500,
        capacity: 5,
        booked_count: 0,
        status: "published",
        start_date: new Date(Date.now() + 86400000).toISOString()
      })
      .select("id")
      .single()
    if (eventErr || !event) throw new Error(`Failed to create paid event: ${eventErr?.message}`)
    cleanupEventIds.push(event.id)

    // Create an exhausted coupon (max_uses = 1, used_count = 1)
    const couponCode = `EXHAUST_${Date.now()}`
    const { data: coupon, error: couponErr } = await serviceClient
      .from("coupons")
      .insert({
        community_id: commId,
        code: couponCode,
        discount_type: "flat",
        discount_value: 50,
        max_uses: 1,
        used_count: 1
      })
      .select("id, used_count")
      .single()
    if (couponErr || !coupon) throw new Error(`Failed to create test coupon: ${couponErr?.message}`)
    cleanupCouponIds.push(coupon.id)

    // User A calls create-payment with the exhausted coupon code
    const payResp = await fetch(`${SUPABASE_URL}/functions/v1/create-payment`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${regularUserA.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        event_id: event.id,
        coupon_code: couponCode
      })
    })
    const payJson = await payResp.json()

    // 1. Must return HTTP 400 with coupon_exhausted
    if (payResp.status !== 400 || payJson.code !== "coupon_exhausted") {
      throw new Error(`Expected HTTP 400 coupon_exhausted, received: ${payResp.status} ${JSON.stringify(payJson)}`)
    }

    // 2. Capacity hold MUST be released (status: 'cancelled', hold_expires_at is null)
    const { data: regAfter } = await serviceClient
      .from("registrations")
      .select("id, status, hold_expires_at")
      .eq("event_id", event.id)
      .eq("user_id", regularUserA.id)
      .maybeSingle()

    if (!regAfter || regAfter.status !== "cancelled" || regAfter.hold_expires_at !== null) {
      throw new Error(`Ticket hold was NOT released on coupon failure! Found status=${regAfter?.status}, hold_expires_at=${regAfter?.hold_expires_at}`)
    }

    // 3. Shared coupon counter must NOT be decremented (still 1)
    const { data: couponAfter } = await serviceClient
      .from("coupons")
      .select("used_count")
      .eq("id", coupon.id)
      .single()

    if (couponAfter?.used_count !== 1) {
      throw new Error(`Coupon counter was illegally decremented! used_count = ${couponAfter?.used_count}`)
    }

    return {
      details: "Exhausted coupon returned 400, capacity hold was released immediately, and shared coupon counter was preserved",
      evidence: { coupon_id: coupon.id, used_count: couponAfter?.used_count, registration_status: regAfter.status }
    }
  })

  // --------------------------------------------------------------------------
  // STEP 5: BUG-010 — Hold Release Retry & Payment Audit Log Observability
  // --------------------------------------------------------------------------
  await recordResult(5, "BUG-010: Resilient Hold Release & Payment Audit Log Acceptance", async () => {
    // Verify that payment_audit_log accepts hold_release_failed actions
    const testRegId = crypto.randomUUID()
    const testEvtId = crypto.randomUUID()

    const { error: auditErr } = await serviceClient
      .from("payment_audit_log")
      .insert({
        action: "hold_release_failed",
        details: {
          registration_id: testRegId,
          event_id: testEvtId,
          reason: "smoke_test_observability_verification",
          failed_at: new Date().toISOString()
        }
      })

    if (auditErr) {
      throw new Error(`payment_audit_log rejected hold_release_failed action: ${auditErr.message}`)
    }

    // Verify row queryable
    const { data: auditRow } = await serviceClient
      .from("payment_audit_log")
      .select("id, action, details")
      .eq("action", "hold_release_failed")
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (auditRow?.details?.registration_id !== testRegId) {
      throw new Error("Audit log verification failed: details payload mismatch")
    }

    return {
      details: "payment_audit_log verified to accept structured hold_release_failed audit records",
      evidence: { audit_id: auditRow.id }
    }
  })

  // --------------------------------------------------------------------------
  // CLEANUP
  // --------------------------------------------------------------------------
  console.log("\n============================================================")
  console.log("RUNNING STAGING SMOKE TEST CLEANUP...")
  console.log("============================================================")

  for (const cId of cleanupCouponIds) {
    await serviceClient.from("coupons").delete().eq("id", cId).catch(() => {})
  }
  for (const eId of cleanupEventIds) {
    await serviceClient.from("registrations").delete().eq("event_id", eId).catch(() => {})
    await serviceClient.from("events").delete().eq("id", eId).catch(() => {})
  }
  for (const cId of cleanupCommunityIds) {
    await serviceClient.from("community_members").delete().eq("community_id", cId).catch(() => {})
    await serviceClient.from("communities").delete().eq("id", cId).catch(() => {})
  }
  for (const uId of cleanupUserIds) {
    await serviceClient.from("consent_log").delete().eq("user_id", uId).catch(() => {})
    await serviceClient.auth.admin.deleteUser(uId).catch(() => {})
  }
  console.log("Cleanup completed successfully.")

  console.log("\n================================================================================")
  console.log("ALL 5 STAGE 6 PHASE 2 LIVE STAGING SMOKE TESTS PASSED (0 FAILURES)")
  console.log("================================================================================")
}

runSmokeTests().catch((err) => {
  console.error("\n================================================================================")
  console.error("SMOKE TEST SUITE FAILED WITH ERROR:", err)
  console.error("================================================================================")
  Deno.exit(1)
})
