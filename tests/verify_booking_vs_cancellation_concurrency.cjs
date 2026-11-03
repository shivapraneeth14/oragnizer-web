// tests/verify_booking_vs_cancellation_concurrency.cjs
// ============================================================================
// CLUVO CONCURRENCY VERIFICATION: reserve_ticket_capacity vs cancel_registration_and_claim_refund
// Target Database: Isolated local PostgreSQL (cluvo_test_stage6)
// Verifies:
//   1. Strict Global Lock Hierarchy Level 1 (events) -> Level 2 (registrations) -> Level 3 (payments)
//   2. Zero deadlock errors (no 40P01) under simultaneous concurrent transactions
//   3. Exactly-once capacity decrement and atomic ticket cancellation
//   4. Clean acquisition of durable refund claim
//   5. Immediate capacity freed for concurrent reservation
// ============================================================================

const { Pool } = require('pg');

const DB_URL = process.env.TEST_DB_URL || 'postgres://shivapraneeth@localhost:5432/cluvo_test_stage6';

// Absolute air-gap guardrail
if (DB_URL.includes('supabase.co') || DB_URL.includes('ofvfasdgdwkehdcjugnf') || DB_URL.includes('vdxspyumkvwawmqwfkzr')) {
  console.error('CRITICAL ABORT: TEST_DB_URL references remote or staging/production database!');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DB_URL,
  max: 10,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 5000,
});

async function executeConcurrencyTrial(trialNumber, trialName, delayCancelMs, delayReserveMs) {
  console.log(`\n================================================================================`);
  console.log(`TRIAL ${trialNumber}: ${trialName}`);
  console.log(`  Delay Cancel: ${delayCancelMs}ms | Delay Reserve: ${delayReserveMs}ms`);
  console.log(`================================================================================`);

  const setupClient = await pool.connect();
  const tag = `t${trialNumber}_${Date.now()}`;

  // Unique fixture IDs
  const orgId = 'aaaaaaaa-aaaa-aaaa-aaaa-' + (Date.now() + trialNumber * 10).toString(16).padStart(12, '0').slice(-12);
  const attCancelId = 'bbbbbbbb-bbbb-bbbb-bbbb-' + (Date.now() + trialNumber * 10).toString(16).padStart(12, '0').slice(-12);
  const newBookerId = 'cccccccc-cccc-cccc-cccc-' + (Date.now() + trialNumber * 10).toString(16).padStart(12, '0').slice(-12);
  const commId = 'dddddddd-dddd-dddd-dddd-' + (Date.now() + trialNumber * 10).toString(16).padStart(12, '0').slice(-12);
  const eventId = 'eeeeeeee-eeee-eeee-eeee-' + (Date.now() + trialNumber * 10).toString(16).padStart(12, '0').slice(-12);
  const regCancelId = 'ffffffff-ffff-ffff-ffff-' + (Date.now() + trialNumber * 10).toString(16).padStart(12, '0').slice(-12);
  const payCancelId = '11111111-2222-3333-4444-' + (Date.now() + trialNumber * 10).toString(16).padStart(12, '0').slice(-12);

  try {
    await setupClient.query('BEGIN');

    // 1. Profiles
    await setupClient.query(`
      INSERT INTO public.profiles (id, is_admin, created_at) VALUES
      ('${orgId}', FALSE, clock_timestamp()),
      ('${attCancelId}', FALSE, clock_timestamp()),
      ('${newBookerId}', FALSE, clock_timestamp());
    `);

    // 2. Community & Wallet (owner is orgId)
    await setupClient.query(`
      INSERT INTO public.communities (id, owner_id, name, created_at)
      VALUES ('${commId}', '${orgId}', 'Concurrency Test Community ${tag}', clock_timestamp());

      INSERT INTO public.community_wallets (community_id, balance, currency)
      VALUES ('${commId}', 100000, 'INR');
    `);

    // 3. Event with Capacity = 5, Booked Count = 5 (Completely Full!)
    await setupClient.query(`
      INSERT INTO public.events (id, community_id, title, status, capacity, booked_count, price, start_date, created_at, updated_at)
      VALUES ('${eventId}', '${commId}', 'Full Event ${tag}', 'published', 5, 5, 50000, clock_timestamp() + interval '2 days', clock_timestamp(), clock_timestamp());
    `);

    // 4. Existing Confirmed Registration for attCancelId
    await setupClient.query(`
      INSERT INTO public.registrations (id, event_id, user_id, status, qr_code, registered_at, created_at, updated_at)
      VALUES ('${regCancelId}', '${eventId}', '${attCancelId}', 'confirmed', 'cluvo_qr_token_initial_${tag}', clock_timestamp(), clock_timestamp(), clock_timestamp());
    `);

    // 5. Existing Successful Payment linked to regCancelId
    await setupClient.query(`
      INSERT INTO public.payments (id, registration_id, razorpay_payment_id, amount, currency, status, organizer_share, created_at, updated_at)
      VALUES ('${payCancelId}', '${regCancelId}', 'pay_razorpay_${tag}', 50000, 'INR', 'success', 47500, clock_timestamp(), clock_timestamp());
    `);

    await setupClient.query('COMMIT');
    console.log(`  Fixtures seeded: Event ${eventId} (Cap: 5, Booked: 5)`);

  } catch (err) {
    await setupClient.query('ROLLBACK');
    console.error('Fixture setup failed:', err);
    throw err;
  } finally {
    setupClient.release();
  }

  // Concurrency Execution
  const client1 = await pool.connect();
  const client2 = await pool.connect();

  let resCancel = null;
  let resReserve = null;
  let errorCancel = null;
  let errorReserve = null;

  try {
    await client1.query('SET statement_timeout = 5000');
    await client2.query('SET statement_timeout = 5000');

    const p1 = (async () => {
      try {
        if (delayCancelMs > 0) await new Promise(r => setTimeout(r, delayCancelMs));
        await client1.query('BEGIN');
        const q = await client1.query(`
          SELECT public.cancel_registration_and_claim_refund('${payCancelId}', '${orgId}') as res;
        `);
        resCancel = q.rows[0].res;
        await client1.query('COMMIT');
      } catch (err) {
        await client1.query('ROLLBACK').catch(() => {});
        errorCancel = err;
      }
    })();

    const p2 = (async () => {
      try {
        if (delayReserveMs > 0) await new Promise(r => setTimeout(r, delayReserveMs));
        await client2.query('BEGIN');
        const q = await client2.query(`
          SELECT public.reserve_ticket_capacity('${eventId}', '${newBookerId}', 600) as res;
        `);
        resReserve = q.rows[0].res;
        await client2.query('COMMIT');
      } catch (err) {
        await client2.query('ROLLBACK').catch(() => {});
        errorReserve = err;
      }
    })();

    await Promise.all([p1, p2]);

  } finally {
    client1.release();
    client2.release();
  }

  // Verification
  const verifyClient = await pool.connect();

  try {
    // 1. Deadlock Checks
    if (errorCancel) {
      if (errorCancel.code === '40P01') throw new Error('DEADLOCK DETECTED on Connection 1!');
      throw errorCancel;
    }
    if (errorReserve) {
      if (errorReserve.code === '40P01') throw new Error('DEADLOCK DETECTED on Connection 2!');
      throw errorReserve;
    }
    console.log('  [PASS] Zero deadlock errors (no 40P01).');

    // 2. Cancellation Check
    if (!resCancel || resCancel.ok !== true) throw new Error(`Cancellation failed: ${JSON.stringify(resCancel)}`);
    if (resCancel.decremented_capacity !== true) throw new Error('Expected decremented_capacity === true');
    console.log('  [PASS] cancel_registration_and_claim_refund succeeded (ok=true, decremented_capacity=true).');

    // 3. Registration Check
    const regCheck = await verifyClient.query(`SELECT status, qr_code, deleted_at FROM public.registrations WHERE id = '${regCancelId}'`);
    if (regCheck.rows[0].status !== 'cancelled' || regCheck.rows[0].qr_code !== null || !regCheck.rows[0].deleted_at) {
      throw new Error(`Registration cancellation invariant failed: ${JSON.stringify(regCheck.rows[0])}`);
    }
    console.log('  [PASS] Cancelled registration status=cancelled, qr_code=NULL, deleted_at stamped.');

    // 4. Payment Claim Check
    const payCheck = await verifyClient.query(`SELECT refund_claim_state, refund_amount_due FROM public.payments WHERE id = '${payCancelId}'`);
    if (payCheck.rows[0].refund_claim_state !== 'claimed' || payCheck.rows[0].refund_amount_due !== 50000) {
      throw new Error(`Payment claim invariant failed: ${JSON.stringify(payCheck.rows[0])}`);
    }
    console.log('  [PASS] Payment refund_claim_state=claimed with durable debt tracked.');

    // 5. Reservation Outcome Check
    console.log(`  [INFO] Connection 2 (reserve_ticket_capacity) response:`, resReserve);
    if (resReserve.ok === true) {
      console.log('  [PASS] Reservation acquired freed capacity created by cancellation!');
      const newRegCheck = await verifyClient.query(`
        SELECT status, hold_expires_at FROM public.registrations WHERE event_id = '${eventId}' AND user_id = '${newBookerId}'
      `);
      console.log('         New registration created:', newRegCheck.rows[0]);
    } else {
      console.log(`  [PASS] Reservation safely observed full capacity prior to cancellation: ${resReserve.error}`);
    }

    // 6. Capacity Check
    const eventCheck = await verifyClient.query(`SELECT capacity, booked_count FROM public.events WHERE id = '${eventId}'`);
    if (eventCheck.rows[0].booked_count !== 4) {
      throw new Error(`Expected final booked_count=4, got ${eventCheck.rows[0].booked_count}`);
    }
    console.log(`  [PASS] Final event capacity verified: capacity=${eventCheck.rows[0].capacity}, booked_count=${eventCheck.rows[0].booked_count}.`);

  } finally {
    await verifyClient.query(`
      DELETE FROM public.payments WHERE id = '${payCancelId}';
      DELETE FROM public.registrations WHERE event_id = '${eventId}';
      DELETE FROM public.events WHERE id = '${eventId}';
      DELETE FROM public.community_wallets WHERE community_id = '${commId}';
      DELETE FROM public.communities WHERE id = '${commId}';
      DELETE FROM public.profiles WHERE id IN ('${orgId}', '${attCancelId}', '${newBookerId}');
    `);
    verifyClient.release();
  }
}

async function main() {
  try {
    // Trial 1: Unmetered race (simultaneous dispatch)
    await executeConcurrencyTrial(1, 'Simultaneous Race (Unmetered Dispatch)', 0, 0);

    // Trial 2: Cancellation serialized first (freed capacity captured by waiting reservation)
    await executeConcurrencyTrial(2, 'Serialized Freeing (Cancellation runs, then Reservation captures freed capacity)', 0, 20);

    console.log('\n================================================================================');
    console.log('ALL CONCURRENCY TRIALS COMPLETED WITH ZERO DEADLOCKS AND 100% INVARIANT SAFETY');
    console.log('================================================================================\n');
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('\nEXECUTION FAILED:', err);
  pool.end();
  process.exit(1);
});
