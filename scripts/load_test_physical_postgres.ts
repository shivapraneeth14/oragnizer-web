// scripts/load_test_physical_postgres.ts
import postgres from "npm:postgres"

interface LoadTestConfig {
  dbUrl: string
  tierName: string
  concurrency: number
  capacity: number
  holdDurationSeconds: number
}

interface LatencyStats {
  min: number
  max: number
  avg: number
  p50: number
  p90: number
  p95: number
  p99: number
}

function calculateLatencyStats(latencies: number[]): LatencyStats {
  if (latencies.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0 }
  const sorted = [...latencies].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, val) => acc + val, 0)
  const p = (pct: number) => sorted[Math.min(Math.floor(sorted.length * pct), sorted.length - 1)]
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
    p50: p(0.50),
    p90: p(0.90),
    p95: p(0.95),
    p99: p(0.99),
  }
}

export async function runPhysicalReservationTier(config: LoadTestConfig) {
  console.log(`\n================================================================================`)
  console.log(`TIER EXECUTION: ${config.tierName}`)
  console.log(`Target: ${config.concurrency} concurrent booking attempts competing for ${config.capacity} tickets`)
  console.log(`================================================================================`)

  const sql = postgres(config.dbUrl, {
    max: Math.min(config.concurrency + 20, 120),
    idle_timeout: 30,
    connect_timeout: 15,
  })

  try {
    // 1. Setup Organizer Profile & Community
    const organizerId = crypto.randomUUID()
    await sql`
      INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
      VALUES (
        ${organizerId}::uuid,
        ${'org_' + config.concurrency + '_' + Date.now() + '@cluvo.test'},
        '{"provider":"email","cluvo_provisioned":true}'::jsonb,
        ${JSON.stringify({ first_name: 'Organizer', username: 'org_' + config.concurrency + '_' + Date.now() })}::jsonb
      );
    `

    const [community] = await sql`
      INSERT INTO public.communities (name, description, owner_id, commission_percent)
      VALUES (
        ${'Physical Community ' + config.concurrency + ' ' + Date.now()},
        'Physical Load Test Community',
        ${organizerId}::uuid,
        6.00
      ) RETURNING id;
    `

    const [event] = await sql`
      INSERT INTO public.events (
        community_id, title, status, price, capacity, booked_count, start_date, end_date
      ) VALUES (
        ${community.id},
        ${'Physical Flash Sale ' + config.concurrency + ' Users'},
        'published',
        10000,
        ${config.capacity},
        0,
        NOW() + INTERVAL '14 days',
        NOW() + INTERVAL '14 days' + INTERVAL '3 hours'
      ) RETURNING id, capacity, booked_count;
    `

    // 2. Pre-create N distinct user accounts in bulk
    console.log(`[SETUP] Pre-creating ${config.concurrency} test attendee profiles...`)
    const userIds: string[] = []
    
    const batchSize = 100
    for (let i = 0; i < config.concurrency; i += batchSize) {
      const currentBatch = Math.min(batchSize, config.concurrency - i)
      const values = []
      for (let j = 0; j < currentBatch; j++) {
        const idx = i + j
        const uid = crypto.randomUUID()
        userIds.push(uid)
        values.push({
          id: uid,
          email: `phys_user_${config.concurrency}_${idx}_${Date.now()}@test.cluvo`,
          raw_app_meta_data: JSON.stringify({ provider: "email", cluvo_provisioned: true }),
          raw_user_meta_data: JSON.stringify({ first_name: "LoadTester", last_name: `#${idx}`, username: `user_${config.concurrency}_${idx}_${Date.now()}` })
        })
      }
      await sql`
        INSERT INTO auth.users ${sql(values, 'id', 'email', 'raw_app_meta_data', 'raw_user_meta_data')};
      `
    }

    console.log(`[SETUP] Created ${userIds.length} profiles successfully. Event ID=${event.id}`)

    // 3. Concurrently execute reserve_ticket_capacity
    console.log(`[BURST] Firing ${config.concurrency} parallel reserve_ticket_capacity transactions...`)

    const startTime = performance.now()
    const promises = userIds.map(async (userId) => {
      const t0 = performance.now()
      try {
        const [rpcRes] = await sql`
          SELECT public.reserve_ticket_capacity(
            ${event.id}::uuid,
            ${userId}::uuid,
            ${config.holdDurationSeconds}::integer
          ) as res;
        `
        const elapsed = Math.round(performance.now() - t0)
        const payload = rpcRes.res
        return {
          userId,
          success: payload.ok === true,
          registrationId: payload.registration_id,
          error: payload.ok ? undefined : payload.error,
          latencyMs: elapsed,
          res: payload,
        }
      } catch (err: any) {
        const elapsed = Math.round(performance.now() - t0)
        return {
          userId,
          success: false,
          error: err.code || err.message,
          latencyMs: elapsed,
        }
      }
    })

    const executedResults = await Promise.all(promises)
    const totalTimeMs = Math.round(performance.now() - startTime)

    // 4. Analyze Reservation Results
    const winners = executedResults.filter(r => r.success)
    const holdsGranted = winners.length
    const capacityHeldRejections = executedResults.filter(r => r.error === 'capacity_held').length
    const deadlocks = executedResults.filter(r => r.error === '40P01').length
    const lockTimeouts = executedResults.filter(r => r.error === '55P03').length
    const otherErrors = executedResults.filter(r => !r.success && r.error !== 'capacity_held' && r.error !== '40P01' && r.error !== '55P03')

    const latencies = executedResults.map(r => r.latencyMs)
    const stats = calculateLatencyStats(latencies)

    console.log(`\n--- ${config.tierName} RESERVATION BURST METRICS ---`)
    console.log(`Total Wall Clock Time: ${totalTimeMs} ms`)
    console.log(`Holds Granted (Winners):  ${holdsGranted} (Expected: exactly ${config.capacity})`)
    console.log(`Capacity Rejections:      ${capacityHeldRejections} (Expected: exactly ${config.concurrency - config.capacity})`)
    console.log(`Deadlocks (40P01):        ${deadlocks} (Mandatory: 0)`)
    console.log(`Lock Timeouts (55P03):    ${lockTimeouts}`)
    console.log(`Other Unexpected Errors:  ${otherErrors.length}`)
    if (otherErrors.length > 0) {
      console.log(`  Other Error Details:`, otherErrors.slice(0, 5).map(e => ({ error: e.error, res: e.res })))
    }
    console.log(`Latency Percentiles:      Min=${stats.min}ms | Avg=${stats.avg}ms | P50=${stats.p50}ms | P95=${stats.p95}ms | P99=${stats.p99}ms | Max=${stats.max}ms`)

    // 5. Database Assertions for Capacity & Holds
    const [eventAfter] = await sql`SELECT booked_count, capacity FROM public.events WHERE id = ${event.id};`
    const [activeHolds] = await sql`
      SELECT COUNT(*) as cnt FROM public.registrations
      WHERE event_id = ${event.id} AND status = 'pending' AND hold_expires_at > clock_timestamp();
    `

    console.log(`[DB CHECK] Active unexpired holds in PostgreSQL: ${activeHolds.cnt}`)
    console.log(`[DB CHECK] Event booked_count in PostgreSQL:     ${eventAfter.booked_count}`)

    // 6. Phase 2: Simultaneous Payment Confirmations by the Winners
    console.log(`\n[PHASE 2] Simulating payment confirmations for the ${winners.length} winning hold holders...`)
    const paymentPromises = winners.map(async (winner, idx) => {
      const paymentId = crypto.randomUUID()
      const razorpayPaymentId = `pay_phys_${config.concurrency}_${idx}_${Date.now()}`
      
      // Insert initial pending payment
      await sql`
        INSERT INTO public.payments (
          id, registration_id, amount, currency, status, platform_fee, razorpay_order_id, razorpay_payment_id
        ) VALUES (
          ${paymentId}::uuid,
          ${winner.registrationId}::uuid,
          10600,
          'INR',
          'pending',
          600,
          ${'order_phys_' + idx},
          ${razorpayPaymentId}
        );
      `

      // Call confirm_payment RPC
      const [confirmRes] = await sql`
        SELECT public.confirm_payment(
          ${paymentId}::uuid,
          10600,
          'INR',
          ${razorpayPaymentId}
        ) as res;
      `
      return { winner, confirmRes: confirmRes.res }
    })

    const confirmedResults = await Promise.all(paymentPromises)
    const confirmedCount = confirmedResults.filter(r => r.confirmRes.action === 'confirmed').length
    console.log(`[PHASE 2 RESULT] Payments successfully confirmed: ${confirmedCount} / ${winners.length}`)

    // 7. Phase 3: Late payment arrival after capacity is full (simulating expired hold)
    let latePaymentRefundRequired = false
    const loser = executedResults.find(r => !r.success)!
    const loserUid = loser.userId
    const [loserReg] = await sql`
      INSERT INTO public.registrations (event_id, user_id, status, hold_expires_at)
      VALUES (${event.id}, ${loserUid}::uuid, 'pending', NOW() - INTERVAL '1 minute')
      RETURNING id;
    `
    const loserPayId = crypto.randomUUID()
    const loserRzpId = `pay_loser_${config.concurrency}_${Date.now()}`
    await sql`
      INSERT INTO public.payments (
        id, registration_id, amount, currency, status, platform_fee, razorpay_order_id, razorpay_payment_id
      ) VALUES (
        ${loserPayId}::uuid,
        ${loserReg.id}::uuid,
        10600,
        'INR',
        'pending',
        600,
        'order_loser',
        ${loserRzpId}
      );
    `
    const [loserConfirm] = await sql`
      SELECT public.confirm_payment(
        ${loserPayId}::uuid,
        10600,
        'INR',
        ${loserRzpId}
      ) as res;
    `
    if (loserConfirm.res.action === 'refund_required') {
      latePaymentRefundRequired = true
      console.log(`[PHASE 3 LATE PAYMENT] Late payment rejected with action=refund_required & reason=${loserConfirm.res.reason} (Zero overselling) ✅`)
    }

    // 8. Phase 4: Unique Constraint Enforcement on razorpay_payment_id
    let duplicateRejected = false
    try {
      const dupePaymentId = crypto.randomUUID()
      // Try inserting with duplicate payment id from winner 0
      const [firstWinnerPay] = await sql`SELECT razorpay_payment_id FROM public.payments WHERE registration_id = ${winners[0].registrationId}::uuid;`
      await sql`
        INSERT INTO public.payments (
          id, registration_id, amount, currency, status, platform_fee, razorpay_order_id, razorpay_payment_id
        ) VALUES (
          ${dupePaymentId}::uuid,
          ${winners[1].registrationId}::uuid,
          10600,
          'INR',
          'pending',
          600,
          'order_dupe',
          ${firstWinnerPay.razorpay_payment_id}
        );
      `
    } catch (dupeErr: any) {
      if (dupeErr.code === '23505') {
        duplicateRejected = true
        console.log(`[PHASE 4 DUPLICATE ID] Duplicate razorpay_payment_id correctly rejected with 23505 ✅`)
      }
    }

    // 9. Verify Final Database Integrity
    const [eventFinal] = await sql`SELECT booked_count, capacity FROM public.events WHERE id = ${event.id};`
    const [confirmedRegs] = await sql`
      SELECT COUNT(*) as cnt FROM public.registrations
      WHERE event_id = ${event.id} AND status = 'confirmed';
    `
    const [holdsFinal] = await sql`
      SELECT COUNT(*) as cnt FROM public.registrations
      WHERE event_id = ${event.id} AND status = 'pending' AND hold_expires_at > clock_timestamp();
    `

    console.log(`[FINAL DB AUDIT] Event booked_count:       ${eventFinal.booked_count} (Must equal ${config.capacity})`)
    console.log(`[FINAL DB AUDIT] Confirmed Registrations: ${confirmedRegs.cnt} (Must equal ${config.capacity})`)
    console.log(`[FINAL DB AUDIT] Remaining Active Holds:  ${holdsFinal.cnt} (Must equal 0)`)

    const passed =
      holdsGranted === config.capacity &&
      capacityHeldRejections === (config.concurrency - config.capacity) &&
      deadlocks === 0 &&
      confirmedCount === config.capacity &&
      Number(eventFinal.booked_count) === config.capacity &&
      Number(confirmedRegs.cnt) === config.capacity &&
      Number(holdsFinal.cnt) === 0 &&
      latePaymentRefundRequired &&
      duplicateRejected

    console.log(`\n================================================================================`)
    console.log(`TIER VERDICT FOR ${config.tierName}: ${passed ? 'PASSED ALL INVARIANTS ✅' : 'FAILED ASSERTIONS ❌'}`)
    console.log(`================================================================================\n`)

    return {
      tierName: config.tierName,
      concurrency: config.concurrency,
      capacity: config.capacity,
      holdsGranted,
      capacityHeldRejections,
      deadlocks,
      lockTimeouts,
      otherErrors: otherErrors.length,
      totalTimeMs,
      stats,
      confirmedCount,
      passed,
    }
  } finally {
    await sql.end()
  }
}

// Master execution runner
async function main() {
  const dbUrl = Deno.env.get("PHYSICAL_PG_URL") || "postgresql://postgres:postgres@localhost:54322/postgres"
  console.log(`Connecting to physical database: ${dbUrl.replace(/:[^:@]+@/, ':****@')}`)

  const tiers = [
    { tierName: "TIER 1 (100 Concurrent Users)", concurrency: 100, capacity: 10, holdDurationSeconds: 600 },
    { tierName: "TIER 2 (500 Concurrent Users)", concurrency: 500, capacity: 50, holdDurationSeconds: 600 },
    { tierName: "TIER 3 (1,000 Concurrent Users)", concurrency: 1000, capacity: 100, holdDurationSeconds: 600 },
  ]

  const summary = []
  for (const tier of tiers) {
    const res = await runPhysicalReservationTier({ dbUrl, ...tier })
    summary.push(res)
  }

  console.log(`\n================================================================================`)
  console.log(`                MASTER PHYSICAL LOAD TEST SUMMARY TABLE`)
  console.log(`================================================================================`)
  console.table(summary.map(s => ({
    Tier: s.tierName,
    Users: s.concurrency,
    Seats: s.capacity,
    Holds: s.holdsGranted,
    Rejected: s.capacityHeldRejections,
    Confirmed: s.confirmedCount,
    Deadlocks: s.deadlocks,
    P50_ms: s.stats.p50,
    P95_ms: s.stats.p95,
    P99_ms: s.stats.p99,
    WallTime_ms: s.totalTimeMs,
    Status: s.passed ? "PASSED ✅" : "FAILED ❌"
  })))
}

if (import.meta.main) {
  await main()
}
