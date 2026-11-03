// tests/verify_postgres_lock_contention.cjs
// ============================================================================
// CLUVO DETERMINISTIC POSTGRESQL LOCK CONTENTION & BLOCKING VERIFICATION
// Target Database: Isolated Local PostgreSQL (cluvo_test_stage6 on localhost:5432)
// Verifies:
//   1. Deterministic lock-wait capture via pg_stat_activity, wait_event_type='Lock',
//      and pg_blocking_pids() showing exact holder-to-waiter blocking.
//   2. Scenario 1: Cancellation holds Level 1 Event lock -> Booking queues on lock
//      -> Cancellation commits -> Booking resumes & claims newly freed capacity.
//   3. Scenario 2: Booking holds Level 1 Event lock -> Cancellation queues on lock
//      -> Booking commits -> Cancellation resumes & decrements capacity.
//   4. Strict absence of PostgreSQL 40P01 deadlocks under forced lock contention.
//   5. Accurate ledger reconciliation: capacity counts, ticket cancellations,
//      and refund claim debt tracking.
// ============================================================================

const { Pool } = require('pg');

const DB_URL = process.env.TEST_DB_URL || 'postgres://shivapraneeth@localhost:5432/cluvo_test_stage6';

// Absolute air-gap verification
if (DB_URL.includes('supabase.co') || DB_URL.includes('ofvfasdgdwkehdcjugnf') || DB_URL.includes('vdxspyumkvwawmqwfkzr')) {
  console.error('CRITICAL ABORT: TEST_DB_URL targets remote staging or production database!');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DB_URL,
  max: 10,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 5000,
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// SCENARIO 1: Cancellation holds Event lock first; Booking waits on lock.
// ============================================================================
async function runScenario1() {
  console.log('\n================================================================================');
  console.log('SCENARIO 1: CANCELLATION HOLDS EVENT LOCK -> BOOKING QUEUES ON EVENT LOCK');
  console.log('================================================================================');

  const setupClient = await pool.connect();
  const connA = await pool.connect();
  const connB = await pool.connect();
  const connMonitor = await pool.connect();

  const tag = `scen1_${Date.now()}`;
  const orgId = '11111111-aaaa-aaaa-aaaa-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const att1Id = '22222222-aaaa-aaaa-aaaa-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const att2Id = '33333333-aaaa-aaaa-aaaa-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const commId = '44444444-aaaa-aaaa-aaaa-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const eventId = '55555555-aaaa-aaaa-aaaa-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const reg1Id = '66666666-aaaa-aaaa-aaaa-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const pay1Id = '77777777-aaaa-aaaa-aaaa-' + Date.now().toString(16).padStart(12, '0').slice(-12);

  try {
    // 1. Setup Fixtures: Event with capacity 5, booked_count 5 (Completely full)
    console.log('--- Step 1.1: Seeding Fixtures (Full Event: Capacity=5, Booked=5) ---');
    await setupClient.query('BEGIN');
    await setupClient.query(`
      INSERT INTO public.profiles (id, is_admin) VALUES
      ('${orgId}', FALSE), ('${att1Id}', FALSE), ('${att2Id}', FALSE);

      INSERT INTO public.communities (id, owner_id, name)
      VALUES ('${commId}', '${orgId}', 'Contention Community ${tag}');

      INSERT INTO public.community_wallets (community_id, balance, currency)
      VALUES ('${commId}', 100000, 'INR');

      INSERT INTO public.events (id, community_id, title, status, capacity, booked_count, price, start_date)
      VALUES ('${eventId}', '${commId}', 'Lock Contention Event ${tag}', 'published', 5, 5, 50000, clock_timestamp() + interval '3 days');

      INSERT INTO public.registrations (id, event_id, user_id, status, qr_code)
      VALUES ('${reg1Id}', '${eventId}', '${att1Id}', 'confirmed', 'cluvo_qr_scen1_${tag}');

      INSERT INTO public.payments (id, registration_id, razorpay_payment_id, amount, currency, status, organizer_share)
      VALUES ('${pay1Id}', '${reg1Id}', 'pay_scen1_${tag}', 50000, 'INR', 'success', 47500);
    `);
    await setupClient.query('COMMIT');

    // 2. Configure Session Timeouts & Discover PIDs
    await connA.query('SET statement_timeout = 8000; SET lock_timeout = 6000;');
    await connB.query('SET statement_timeout = 8000; SET lock_timeout = 6000;');
    const pidA = (await connA.query('SELECT pg_backend_pid() as pid')).rows[0].pid;
    const pidB = (await connB.query('SELECT pg_backend_pid() as pid')).rows[0].pid;
    console.log(`--- Step 1.2: Connections Established ---`);
    console.log(`  Connection A (Cancellation): PID ${pidA}`);
    console.log(`  Connection B (Reservation):  PID ${pidB}`);

    // 3. Connection A starts transaction and explicitly locks the event row (Level 1)
    console.log('\n--- Step 1.3: Connection A Acquires Level 1 Event Row Lock ---');
    await connA.query('BEGIN');
    const txAInfo = (await connA.query('SELECT txid_current() as txid')).rows[0].txid;
    await connA.query(`SELECT id, title, booked_count FROM public.events WHERE id = '${eventId}' FOR UPDATE;`);
    console.log(`  Connection A (PID ${pidA}, TXID ${txAInfo}) holds FOR UPDATE lock on Event ${eventId}`);

    // 4. Connection B starts transaction and calls reserve_ticket_capacity
    // Because it must lock the same event row Level 1, it will block waiting for Connection A!
    console.log('\n--- Step 1.4: Connection B Dispatches reserve_ticket_capacity (Queues on Event Lock) ---');
    let bCompleted = false;
    let bResult = null;
    let bError = null;

    const bPromise = (async () => {
      try {
        await connB.query('BEGIN');
        const q = await connB.query(`
          SELECT public.reserve_ticket_capacity('${eventId}', '${att2Id}', 600) as res;
        `);
        bResult = q.rows[0].res;
        await connB.query('COMMIT');
      } catch (err) {
        await connB.query('ROLLBACK').catch(() => {});
        bError = err;
      } finally {
        bCompleted = true;
      }
    })();

    // 5. Observer Connection queries pg_stat_activity to capture lock contention evidence
    console.log('\n--- Step 1.5: Querying pg_stat_activity for Real PostgreSQL Lock Contention ---');
    let lockObserved = false;
    let lockWaitRecord = null;

    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const monRes = await connMonitor.query(`
        SELECT 
          pid, 
          state, 
          wait_event_type, 
          wait_event, 
          pg_blocking_pids(pid) as blocking_pids,
          query
        FROM pg_stat_activity 
        WHERE pid = $1
      `, [pidB]);

      const row = monRes.rows[0];
      if (row && row.wait_event_type === 'Lock' && Array.isArray(row.blocking_pids) && row.blocking_pids.includes(pidA)) {
        lockObserved = true;
        lockWaitRecord = row;
        break;
      }
    }

    if (!lockObserved) {
      throw new Error(`FAILURE: PostgreSQL did not report PID ${pidB} waiting on PID ${pidA}!`);
    }

    console.log('  *** LIVE POSTGRESQL LOCK CONTENTION EVIDENCE CAPTURED ***');
    console.log(`    Waiting PID:       ${lockWaitRecord.pid}`);
    console.log(`    State:             ${lockWaitRecord.state}`);
    console.log(`    Wait Event Type:   ${lockWaitRecord.wait_event_type}`);
    console.log(`    Wait Event:        ${lockWaitRecord.wait_event}`);
    console.log(`    Blocking PIDs:     [${lockWaitRecord.blocking_pids.join(', ')}] (Matches Connection A PID ${pidA})`);
    console.log(`    Waiting Query:     ${lockWaitRecord.query.trim().slice(0, 100)}...`);

    // 6. While Connection B is actively waiting on Connection A, Connection A executes cancellation and commits
    console.log('\n--- Step 1.6: Connection A Completes cancel_registration_and_claim_refund & Commits ---');
    const cancelQuery = await connA.query(`
      SELECT public.cancel_registration_and_claim_refund('${pay1Id}', '${orgId}') as res;
    `);
    const cancelRes = cancelQuery.rows[0].res;
    await connA.query('COMMIT');
    console.log('  Connection A committed. Lock released.');
    console.log('  Cancellation result:', cancelRes);

    // 7. Await Connection B completion
    console.log('\n--- Step 1.7: Awaiting Connection B Unblock & Completion ---');
    await bPromise;

    if (bError) throw bError;
    console.log('  Connection B unblocked and committed successfully!');
    console.log('  Reservation result:', bResult);

    // 8. Invariant Verification
    console.log('\n--- Step 1.8: Verifying Scenario 1 Invariants ---');
    // Check 1: cancel_registration_and_claim_refund succeeded
    if (!cancelRes || cancelRes.ok !== true || cancelRes.decremented_capacity !== true) {
      throw new Error(`Cancellation failed: ${JSON.stringify(cancelRes)}`);
    }
    console.log('  [PASS] cancel_registration_and_claim_refund returned ok=true, decremented_capacity=true');

    // Check 2: Connection B captured the newly freed capacity (booked_count went 5 -> 4, so reservation succeeded!)
    if (!bResult || bResult.ok !== true) {
      throw new Error(`Expected reservation to capture freed capacity, got: ${JSON.stringify(bResult)}`);
    }
    console.log('  [PASS] reserve_ticket_capacity captured newly freed capacity: ok=true, hold created');

    // Check 3: Registration 1 is cancelled and QR is wiped
    const r1 = (await connMonitor.query(`SELECT status, qr_code, deleted_at FROM public.registrations WHERE id = '${reg1Id}'`)).rows[0];
    if (r1.status !== 'cancelled' || r1.qr_code !== null || !r1.deleted_at) {
      throw new Error(`Registration 1 not properly cancelled: ${JSON.stringify(r1)}`);
    }
    console.log('  [PASS] Registration 1 status=cancelled, qr_code=NULL, deleted_at stamped');

    // Check 4: Payment 1 refund claim state is claimed
    const p1 = (await connMonitor.query(`SELECT refund_claim_state, refund_amount_due FROM public.payments WHERE id = '${pay1Id}'`)).rows[0];
    if (p1.refund_claim_state !== 'claimed' || p1.refund_amount_due !== 50000) {
      throw new Error(`Payment 1 refund claim state invalid: ${JSON.stringify(p1)}`);
    }
    console.log('  [PASS] Payment 1 refund_claim_state=claimed, refund_amount_due=50000');

    // Check 5: Registration 2 (Hold) exists in pending status
    const r2 = (await connMonitor.query(`SELECT status, hold_expires_at FROM public.registrations WHERE event_id = '${eventId}' AND user_id = '${att2Id}'`)).rows[0];
    if (r2.status !== 'pending' || !r2.hold_expires_at) {
      throw new Error(`Registration 2 hold not created: ${JSON.stringify(r2)}`);
    }
    console.log('  [PASS] Registration 2 hold created in pending status');

    // Check 6: Capacity decremented exactly once from 5 to 4
    const ev = (await connMonitor.query(`SELECT capacity, booked_count FROM public.events WHERE id = '${eventId}'`)).rows[0];
    if (ev.booked_count !== 4) {
      throw new Error(`Expected booked_count=4, got ${ev.booked_count}`);
    }
    console.log(`  [PASS] Event capacity verified: capacity=${ev.capacity}, booked_count=${ev.booked_count} (Decremented exactly once)`);

  } finally {
    console.log('\n--- Step 1.9: Cleaning Up Scenario 1 Fixtures ---');
    await setupClient.query(`
      DELETE FROM public.payments WHERE id = '${pay1Id}';
      DELETE FROM public.registrations WHERE event_id = '${eventId}';
      DELETE FROM public.events WHERE id = '${eventId}';
      DELETE FROM public.community_wallets WHERE community_id = '${commId}';
      DELETE FROM public.communities WHERE id = '${commId}';
      DELETE FROM public.profiles WHERE id IN ('${orgId}', '${att1Id}', '${att2Id}');
    `).catch(() => {});

    setupClient.release();
    connA.release();
    connB.release();
    connMonitor.release();
  }
}

// ============================================================================
// SCENARIO 2: Booking holds Event lock first; Cancellation queues on lock.
// ============================================================================
async function runScenario2() {
  console.log('\n================================================================================');
  console.log('SCENARIO 2: BOOKING HOLDS EVENT LOCK -> CANCELLATION QUEUES ON EVENT LOCK');
  console.log('================================================================================');

  const setupClient = await pool.connect();
  const connA = await pool.connect();
  const connB = await pool.connect();
  const connMonitor = await pool.connect();

  const tag = `scen2_${Date.now()}`;
  const orgId = '11111111-bbbb-bbbb-bbbb-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const att1Id = '22222222-bbbb-bbbb-bbbb-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const att2Id = '33333333-bbbb-bbbb-bbbb-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const commId = '44444444-bbbb-bbbb-bbbb-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const eventId = '55555555-bbbb-bbbb-bbbb-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const reg1Id = '66666666-bbbb-bbbb-bbbb-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const pay1Id = '77777777-bbbb-bbbb-bbbb-' + Date.now().toString(16).padStart(12, '0').slice(-12);

  try {
    // 1. Setup Fixtures: Event with capacity 5, booked_count 4 (1 seat open)
    console.log('--- Step 2.1: Seeding Fixtures (Available Event: Capacity=5, Booked=4) ---');
    await setupClient.query('BEGIN');
    await setupClient.query(`
      INSERT INTO public.profiles (id, is_admin) VALUES
      ('${orgId}', FALSE), ('${att1Id}', FALSE), ('${att2Id}', FALSE);

      INSERT INTO public.communities (id, owner_id, name)
      VALUES ('${commId}', '${orgId}', 'Contention Community 2 ${tag}');

      INSERT INTO public.community_wallets (community_id, balance, currency)
      VALUES ('${commId}', 100000, 'INR');

      INSERT INTO public.events (id, community_id, title, status, capacity, booked_count, price, start_date)
      VALUES ('${eventId}', '${commId}', 'Lock Contention Event 2 ${tag}', 'published', 5, 4, 50000, clock_timestamp() + interval '3 days');

      INSERT INTO public.registrations (id, event_id, user_id, status, qr_code)
      VALUES ('${reg1Id}', '${eventId}', '${att1Id}', 'confirmed', 'cluvo_qr_scen2_${tag}');

      INSERT INTO public.payments (id, registration_id, razorpay_payment_id, amount, currency, status, organizer_share)
      VALUES ('${pay1Id}', '${reg1Id}', 'pay_scen2_${tag}', 50000, 'INR', 'success', 47500);
    `);
    await setupClient.query('COMMIT');

    // 2. Timeouts and PIDs
    await connA.query('SET statement_timeout = 8000; SET lock_timeout = 6000;');
    await connB.query('SET statement_timeout = 8000; SET lock_timeout = 6000;');
    const pidA = (await connA.query('SELECT pg_backend_pid() as pid')).rows[0].pid;
    const pidB = (await connB.query('SELECT pg_backend_pid() as pid')).rows[0].pid;
    console.log(`--- Step 2.2: Connections Established ---`);
    console.log(`  Connection A (Reservation):   PID ${pidA}`);
    console.log(`  Connection B (Cancellation):  PID ${pidB}`);

    // 3. Connection A starts transaction and acquires Level 1 Event lock
    console.log('\n--- Step 2.3: Connection A Acquires Level 1 Event Row Lock ---');
    await connA.query('BEGIN');
    const txAInfo = (await connA.query('SELECT txid_current() as txid')).rows[0].txid;
    await connA.query(`SELECT id, booked_count FROM public.events WHERE id = '${eventId}' FOR UPDATE;`);
    console.log(`  Connection A (PID ${pidA}, TXID ${txAInfo}) holds FOR UPDATE lock on Event ${eventId}`);

    // 4. Connection B starts transaction and calls cancel_registration_and_claim_refund
    // It discovers foreign keys non-locking, then attempts Level 1 Lock on Event -> BLOCKS on Connection A!
    console.log('\n--- Step 2.4: Connection B Dispatches cancel_registration_and_claim_refund (Queues on Event Lock) ---');
    let bCompleted = false;
    let bResult = null;
    let bError = null;

    const bPromise = (async () => {
      try {
        await connB.query('BEGIN');
        const q = await connB.query(`
          SELECT public.cancel_registration_and_claim_refund('${pay1Id}', '${orgId}') as res;
        `);
        bResult = q.rows[0].res;
        await connB.query('COMMIT');
      } catch (err) {
        await connB.query('ROLLBACK').catch(() => {});
        bError = err;
      } finally {
        bCompleted = true;
      }
    })();

    // 5. Observer Connection checks pg_stat_activity for Connection B blocked by Connection A
    console.log('\n--- Step 2.5: Querying pg_stat_activity for Real PostgreSQL Lock Contention ---');
    let lockObserved = false;
    let lockWaitRecord = null;

    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const monRes = await connMonitor.query(`
        SELECT 
          pid, 
          state, 
          wait_event_type, 
          wait_event, 
          pg_blocking_pids(pid) as blocking_pids,
          query
        FROM pg_stat_activity 
        WHERE pid = $1
      `, [pidB]);

      const row = monRes.rows[0];
      if (row && row.wait_event_type === 'Lock' && Array.isArray(row.blocking_pids) && row.blocking_pids.includes(pidA)) {
        lockObserved = true;
        lockWaitRecord = row;
        break;
      }
    }

    if (!lockObserved) {
      throw new Error(`FAILURE: PostgreSQL did not report PID ${pidB} waiting on PID ${pidA}!`);
    }

    console.log('  *** LIVE POSTGRESQL LOCK CONTENTION EVIDENCE CAPTURED ***');
    console.log(`    Waiting PID:       ${lockWaitRecord.pid}`);
    console.log(`    State:             ${lockWaitRecord.state}`);
    console.log(`    Wait Event Type:   ${lockWaitRecord.wait_event_type}`);
    console.log(`    Wait Event:        ${lockWaitRecord.wait_event}`);
    console.log(`    Blocking PIDs:     [${lockWaitRecord.blocking_pids.join(', ')}] (Matches Connection A PID ${pidA})`);
    console.log(`    Waiting Query:     ${lockWaitRecord.query.trim().slice(0, 100)}...`);

    // 6. Connection A completes reserve_ticket_capacity and commits
    console.log('\n--- Step 2.6: Connection A Completes reserve_ticket_capacity & Commits ---');
    const reserveQuery = await connA.query(`
      SELECT public.reserve_ticket_capacity('${eventId}', '${att2Id}', 600) as res;
    `);
    const reserveRes = reserveQuery.rows[0].res;
    await connA.query('COMMIT');
    console.log('  Connection A committed. Lock released.');
    console.log('  Reservation result:', reserveRes);

    // 7. Await Connection B completion
    console.log('\n--- Step 2.7: Awaiting Connection B Unblock & Completion ---');
    await bPromise;

    if (bError) throw bError;
    console.log('  Connection B unblocked and committed successfully!');
    console.log('  Cancellation result:', bResult);

    // 8. Invariant Verification
    console.log('\n--- Step 2.8: Verifying Scenario 2 Invariants ---');
    if (!reserveRes || reserveRes.ok !== true) {
      throw new Error(`Reservation failed: ${JSON.stringify(reserveRes)}`);
    }
    console.log('  [PASS] reserve_ticket_capacity succeeded while holding Level 1 lock');

    if (!bResult || bResult.ok !== true || bResult.decremented_capacity !== true) {
      throw new Error(`Cancellation failed upon unblocking: ${JSON.stringify(bResult)}`);
    }
    console.log('  [PASS] cancel_registration_and_claim_refund resumed safely upon lock release');

    // Check Registration 1 is cancelled
    const r1 = (await connMonitor.query(`SELECT status, qr_code, deleted_at FROM public.registrations WHERE id = '${reg1Id}'`)).rows[0];
    if (r1.status !== 'cancelled' || r1.qr_code !== null || !r1.deleted_at) {
      throw new Error(`Registration 1 invalid: ${JSON.stringify(r1)}`);
    }
    console.log('  [PASS] Registration 1 status=cancelled, qr_code=NULL, deleted_at stamped');

    // Check Payment 1 refund claim state
    const p1 = (await connMonitor.query(`SELECT refund_claim_state, refund_amount_due FROM public.payments WHERE id = '${pay1Id}'`)).rows[0];
    if (p1.refund_claim_state !== 'claimed' || p1.refund_amount_due !== 50000) {
      throw new Error(`Payment 1 refund claim state invalid: ${JSON.stringify(p1)}`);
    }
    console.log('  [PASS] Payment 1 refund_claim_state=claimed, refund_amount_due=50000');

    // Check Capacity: was 4, booked_count decremented to 3
    const ev = (await connMonitor.query(`SELECT capacity, booked_count FROM public.events WHERE id = '${eventId}'`)).rows[0];
    if (ev.booked_count !== 3) {
      throw new Error(`Expected final booked_count=3, got ${ev.booked_count}`);
    }
    console.log(`  [PASS] Event capacity verified: capacity=${ev.capacity}, booked_count=${ev.booked_count} (Decremented exactly once from 4 to 3)`);

  } finally {
    console.log('\n--- Step 2.9: Cleaning Up Scenario 2 Fixtures ---');
    await setupClient.query(`
      DELETE FROM public.payments WHERE id = '${pay1Id}';
      DELETE FROM public.registrations WHERE event_id = '${eventId}';
      DELETE FROM public.events WHERE id = '${eventId}';
      DELETE FROM public.community_wallets WHERE community_id = '${commId}';
      DELETE FROM public.communities WHERE id = '${commId}';
      DELETE FROM public.profiles WHERE id IN ('${orgId}', '${att1Id}', '${att2Id}');
    `).catch(() => {});

    setupClient.release();
    connA.release();
    connB.release();
    connMonitor.release();
  }
}

async function main() {
  try {
    await runScenario1();
    await runScenario2();

    console.log('\n================================================================================');
    console.log('DETERMINISTIC POSTGRESQL LOCK CONTENTION VERIFICATION: 100% SUCCESS');
    console.log('Actual blocking relationships observed in pg_stat_activity in both directions.');
    console.log('Zero deadlocks (40P01), zero overselling, zero duplicate decrements.');
    console.log('================================================================================\n');
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('\nLOCK CONTENTION VERIFICATION FAILED:', err);
  pool.end();
  process.exit(1);
});

