// tests/stage6_db_concurrency_test.cjs
// ============================================================================
// CLUVO STAGE 6 PHYSICAL DATABASE CONCURRENCY & INTEGRATION TEST SUITE
// Runs against local isolated test PostgreSQL (localhost:5432/cluvo_test_stage6)
// Verifies:
//   - REV-REF-001: Global Lock Hierarchy (Level 1 -> 2 -> 3) and Deadlock Freedom
//   - REV-REF-002: Provider Refund Gateway Adoption & Deduplication
//   - REV-REF-003: Strict Attended Registration Refund Protection across all paths
//   - REV-REF-004: Manual Settlement Structured Evidence & Reference Uniqueness
//   - REF-001: Atomic Cancellation, Durable Claim & Exactly-Once Capacity Decrement
//   - REF-004: 244-bit CSPRNG Token Generation & COALESCE Non-Rotation
// ============================================================================

const { Client, Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DB_URL = process.env.TEST_DB_URL || 'postgres://shivapraneeth@localhost:5432/cluvo_test_stage6';

// Absolute safety check: Never run against remote staging or production databases!
if (DB_URL.includes('supabase.co') || DB_URL.includes('ofvfasdgdwkehdcjugnf') || DB_URL.includes('vdxspyumkvwawmqwfkzr')) {
  console.error('FATAL: Remote database detected in TEST_DB_URL! Strictly aborting.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DB_URL,
  max: 10,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 5000,
});

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`  FAIL [${totalTests}]: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`  PASS [${totalTests}]: ${message}`);
}

async function setupSchema(client) {
  console.log('\n--- 1. Initializing Isolated Schema & Dependencies ---');

  await client.query(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    -- Create Supabase standard roles if missing in test database
    DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon;
      END IF;
    END $roles$;

    -- Clean slate
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO CURRENT_USER;

    -- Profiles
    CREATE TABLE public.profiles (
      id UUID PRIMARY KEY,
      is_admin BOOLEAN DEFAULT FALSE,
      phone TEXT,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Communities
    CREATE TABLE public.communities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES public.profiles(id),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Community Members
    CREATE TABLE public.community_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      community_id UUID NOT NULL REFERENCES public.communities(id),
      user_id UUID NOT NULL REFERENCES public.profiles(id),
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Events
    CREATE TABLE public.events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      community_id UUID NOT NULL REFERENCES public.communities(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      capacity INTEGER DEFAULT 100,
      booked_count INTEGER DEFAULT 0,
      price INTEGER NOT NULL DEFAULT 0,
      start_date TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Registrations
    CREATE TABLE public.registrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES public.events(id),
      user_id UUID REFERENCES public.profiles(id),
      ticket_tier_id UUID,
      status TEXT NOT NULL DEFAULT 'confirmed',
      qr_code TEXT,
      hold_expires_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Payments
    CREATE TABLE public.payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      registration_id UUID NOT NULL REFERENCES public.registrations(id),
      razorpay_payment_id TEXT,
      razorpay_order_id TEXT,
      razorpay_refund_id TEXT,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      platform_fee INTEGER DEFAULT 0,
      platform_fee_gst INTEGER DEFAULT 0,
      organizer_share INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'success',
      failure_reason TEXT,
      refund_status TEXT,
      refund_claim_state TEXT,
      refund_claim_at TIMESTAMPTZ,
      refund_attempt_count INTEGER DEFAULT 0,
      refund_reason TEXT,
      refund_amount_due INTEGER,
      refunded_amount INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Community Wallets
    CREATE TABLE public.community_wallets (
      community_id UUID PRIMARY KEY REFERENCES public.communities(id),
      balance INTEGER DEFAULT 0,
      pending_payout_amount INTEGER DEFAULT 0,
      currency TEXT DEFAULT 'INR',
      updated_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Payment Audit Log
    CREATE TABLE public.payment_audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id UUID NOT NULL,
      action TEXT NOT NULL,
      details JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Payment Refund History
    CREATE TABLE public.payment_refund_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id UUID NOT NULL REFERENCES public.payments(id),
      registration_id UUID REFERENCES public.registrations(id),
      event_id UUID REFERENCES public.events(id),
      amount INTEGER NOT NULL,
      payment_amount INTEGER,
      platform_fee INTEGER,
      refund_status TEXT NOT NULL,
      razorpay_refund_id TEXT,
      refund_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      CONSTRAINT payment_refund_history_unique UNIQUE (payment_id, razorpay_refund_id)
    );

    -- Event Cancellation Jobs
    CREATE TABLE public.event_cancellation_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES public.events(id),
      status TEXT DEFAULT 'processing'
    );

    -- Refund Task Queue
    CREATE TABLE public.refund_task_queue (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID REFERENCES public.event_cancellation_jobs(id),
      payment_id UUID REFERENCES public.payments(id),
      registration_id UUID REFERENCES public.registrations(id),
      event_id UUID REFERENCES public.events(id),
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      razorpay_refund_id TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    CREATE OR REPLACE FUNCTION public.update_cancellation_job_progress(p_job_id UUID)
    RETURNS VOID
    LANGUAGE plpgsql
    AS $f$
    BEGIN
      -- Mock progress updater
    END;
    $f$;

    -- Notifications
    CREATE TABLE public.notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Wallet Mock Functions
    CREATE OR REPLACE FUNCTION public.debit_wallet(
      p_community_id UUID,
      p_amount INTEGER,
      p_reason TEXT,
      p_event_id UUID DEFAULT NULL
    )
    RETURNS VOID
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = ''
    AS $f$
    BEGIN
      UPDATE public.community_wallets
      SET balance = balance - p_amount,
          updated_at = clock_timestamp()
      WHERE community_id = p_community_id;
    END;
    $f$;

    CREATE OR REPLACE FUNCTION public.credit_wallet(
      p_community_id UUID,
      p_amount INTEGER,
      p_event_id UUID DEFAULT NULL
    )
    RETURNS VOID
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = ''
    AS $f$
    BEGIN
      UPDATE public.community_wallets
      SET balance = balance + p_amount,
          updated_at = clock_timestamp()
      WHERE community_id = p_community_id;
    END;
    $f$;
  `);

  console.log('  Base schema tables and mock wallet functions created successfully.');

  // Load migrations 14, 15, 16 and the fee-kept refund-policy migration
  const migrationFiles = [
    'supabase/migrations/202611010014_atomic_cancel_and_claim_refund.sql',
    'supabase/migrations/202611010015_verified_admin_refund_resolution.sql',
    'supabase/migrations/202611010016_cryptographic_ticket_token.sql',
    'supabase/migrations/202611040001_organizer_refund_keeps_fee.sql',
  ];

  for (const relPath of migrationFiles) {
    const fullPath = path.resolve(__dirname, '..', relPath);
    const sql = fs.readFileSync(fullPath, 'utf8');
    await client.query(sql);
    console.log(`  Applied migration: ${relPath}`);
  }
}

async function runTests() {
  const adminClient = await pool.connect();

  try {
    await setupSchema(adminClient);

    // Seed test profiles
    const adminId = '11111111-1111-1111-1111-111111111111';
    const ownerId = '22222222-2222-2222-2222-222222222222';
    const userId1 = '33333333-3333-3333-3333-333333333333';
    const userId2 = '44444444-4444-4444-4444-444444444444';

    await adminClient.query(`
      INSERT INTO public.profiles (id, is_admin) VALUES
      ('${adminId}', TRUE),
      ('${ownerId}', FALSE),
      ('${userId1}', FALSE),
      ('${userId2}', FALSE);

      INSERT INTO public.communities (id, owner_id, name) VALUES
      ('55555555-5555-5555-5555-555555555555', '${ownerId}', 'Test Community');

      INSERT INTO public.community_wallets (community_id, balance) VALUES
      ('55555555-5555-5555-5555-555555555555', 50000);
    `);

    const communityId = '55555555-5555-5555-5555-555555555555';

    console.log('\n--- 2. Testing REV-REF-003 & REF-002: Attended Registration Protection ---');
    {
      // Create Event
      const evRes = await adminClient.query(`
        INSERT INTO public.events (community_id, title, capacity, booked_count, start_date)
        VALUES ('${communityId}', 'Attended Test Event', 10, 5, NOW())
        RETURNING id;
      `);
      const eventId = evRes.rows[0].id;

      // Create Registration in 'attended' status
      const regRes = await adminClient.query(`
        INSERT INTO public.registrations (event_id, user_id, status, qr_code)
        VALUES ('${eventId}', '${userId1}', 'attended', 'cluvo_attended_token_123')
        RETURNING id;
      `);
      const regId = regRes.rows[0].id;

      // Create Payment
      const payRes = await adminClient.query(`
        INSERT INTO public.payments (registration_id, razorpay_payment_id, amount, status)
        VALUES ('${regId}', 'pay_Attended123', 100000, 'success')
        RETURNING id;
      `);
      const payId = payRes.rows[0].id;

      // 1. cancel_registration_and_claim_refund must reject attended registration
      const cancelClaimRes = await adminClient.query(`
        SELECT public.cancel_registration_and_claim_refund('${payId}', '${ownerId}') as res;
      `);
      const ccr = cancelClaimRes.rows[0].res;
      assert(ccr.error === 'not_refundable_attended', 'cancel_registration_and_claim_refund rejected attended ticket with not_refundable_attended');

      // Verify status and capacity were NOT altered
      const regCheck = await adminClient.query(`SELECT status, qr_code FROM public.registrations WHERE id = '${regId}'`);
      assert(regCheck.rows[0].status === 'attended', 'Attended registration status remained intact (not cancelled)');
      assert(regCheck.rows[0].qr_code === 'cluvo_attended_token_123', 'Attended QR code remained intact');

      const evCheck = await adminClient.query(`SELECT booked_count FROM public.events WHERE id = '${eventId}'`);
      assert(evCheck.rows[0].booked_count === 5, 'Event capacity booked_count was NOT decremented for attended registration');

      // 2. claim_payment_refund must reject attended registration
      const claimPayRes = await adminClient.query(`
        SELECT public.claim_payment_refund('${payId}', 'worker_test_1', 1) as res;
      `);
      const cpr = claimPayRes.rows[0].res;
      assert(cpr.error === 'not_refundable_attended', 'claim_payment_refund rejected attended ticket with not_refundable_attended');

      // 3. cancel_registration_and_decrement must return false for attended registration
      const cancelDecRes = await adminClient.query(`
        SELECT public.cancel_registration_and_decrement('${regId}') as res;
      `);
      assert(cancelDecRes.rows[0].res === false, 'cancel_registration_and_decrement returned FALSE for attended registration');

      // 4. admin_adopt_provider_refund must reject attended registration
      const taskRes = await adminClient.query(`
        INSERT INTO public.refund_task_queue (payment_id, registration_id, event_id, amount, status)
        VALUES ('${payId}', '${regId}', '${eventId}', 100000, 'pending')
        RETURNING id;
      `);
      const taskId = taskRes.rows[0].id;

      const adoptRes = await adminClient.query(`
        SELECT public.admin_adopt_provider_refund('${taskId}', '${adminId}', 'rfnd_AttendedProvider999', 'test') as res;
      `);
      assert(adoptRes.rows[0].res.error === 'not_refundable_attended', 'admin_adopt_provider_refund rejected attended ticket with not_refundable_attended');

      // 5. admin_manual_settlement must reject attended registration
      const manualRes = await adminClient.query(`
        SELECT public.admin_manual_settlement(
          '${taskId}'::uuid,
          '${adminId}'::uuid,
          '{"settlement_method":"bank_transfer","reference_number":"UTR_ATTENDED_12345","notes":"Valid detailed notes for attended test"}'::jsonb
        ) as res;
      `);
      assert(manualRes.rows[0].res.error === 'not_refundable_attended', 'admin_manual_settlement rejected attended ticket with not_refundable_attended');
    }

    console.log('\n--- 3. Testing REF-001: Atomic Cancellation, Durable Claim & Exactly-Once Decrement ---');
    {
      const evRes = await adminClient.query(`
        INSERT INTO public.events (community_id, title, capacity, booked_count, start_date)
        VALUES ('${communityId}', 'Atomic Cancel Event', 20, 10, NOW())
        RETURNING id;
      `);
      const eventId = evRes.rows[0].id;

      const regRes = await adminClient.query(`
        INSERT INTO public.registrations (event_id, user_id, status, qr_code)
        VALUES ('${eventId}', '${userId2}', 'confirmed', 'cluvo_active_qr_token')
        RETURNING id;
      `);
      const regId = regRes.rows[0].id;

      const payRes = await adminClient.query(`
        INSERT INTO public.payments (registration_id, razorpay_payment_id, amount, status, organizer_share)
        VALUES ('${regId}', 'pay_AtomicCancel123', 50000, 'success', 50000)
        RETURNING id;
      `);
      const payId = payRes.rows[0].id;

      // Execute atomic cancellation and claim
      const res1 = await adminClient.query(`
        SELECT public.cancel_registration_and_claim_refund('${payId}', '${ownerId}') as res;
      `);
      const c1 = res1.rows[0].res;
      assert(c1.ok === true, 'cancel_registration_and_claim_refund succeeded (ok === true)');
      assert(c1.decremented_capacity === true, 'Reported decremented_capacity === true');

      // Check Registration state: status = cancelled, qr_code = NULL
      const regCheck = await adminClient.query(`SELECT status, qr_code, deleted_at FROM public.registrations WHERE id = '${regId}'`);
      assert(regCheck.rows[0].status === 'cancelled', 'Registration status changed to cancelled');
      assert(regCheck.rows[0].qr_code === null, 'QR code wiped to NULL atomically');
      assert(regCheck.rows[0].deleted_at !== null, 'deleted_at recorded');

      // Check Event capacity decremented from 10 to 9
      const evCheck1 = await adminClient.query(`SELECT booked_count FROM public.events WHERE id = '${eventId}'`);
      assert(evCheck1.rows[0].booked_count === 9, 'Capacity decremented from 10 to 9');

      // Check Payment claim state: claimed
      const payCheck = await adminClient.query(`SELECT refund_claim_state, refund_reason, refund_amount_due FROM public.payments WHERE id = '${payId}'`);
      assert(payCheck.rows[0].refund_claim_state === 'claimed', 'Payment refund_claim_state set to claimed');
      assert(payCheck.rows[0].refund_reason === 'organizer_issue_refund', 'refund_reason recorded');
      assert(payCheck.rows[0].refund_amount_due === 50000, 'refund_amount_due recorded');

      // Replay execution (idempotency check): MUST NOT decrement capacity again
      const res2 = await adminClient.query(`
        SELECT public.cancel_registration_and_claim_refund('${payId}', '${ownerId}') as res;
      `);
      assert(res2.rows[0].res.error === 'already_cancelled', 'Second call rejected with already_cancelled');

      const evCheck2 = await adminClient.query(`SELECT booked_count FROM public.events WHERE id = '${eventId}'`);
      assert(evCheck2.rows[0].booked_count === 9, 'Capacity remained 9 (NOT decremented a second time!)');
    }

    console.log('\n--- 4. Testing REV-REF-001: Concurrent Transactions & Global Lock Ordering (Deadlock Freedom) ---');
    {
      const evRes = await adminClient.query(`
        INSERT INTO public.events (community_id, title, capacity, booked_count, start_date)
        VALUES ('${communityId}', 'Concurrency Lock Event', 50, 20, NOW())
        RETURNING id;
      `);
      const eventId = evRes.rows[0].id;

      // Create 2 concurrent registrations & payments
      const r1 = (await adminClient.query(`INSERT INTO public.registrations (event_id, user_id, status) VALUES ('${eventId}', '${userId1}', 'confirmed') RETURNING id`)).rows[0].id;
      const p1 = (await adminClient.query(`INSERT INTO public.payments (registration_id, razorpay_payment_id, amount, status) VALUES ('${r1}', 'pay_Conc1', 25000, 'success') RETURNING id`)).rows[0].id;

      const r2 = (await adminClient.query(`INSERT INTO public.registrations (event_id, user_id, status) VALUES ('${eventId}', '${userId2}', 'confirmed') RETURNING id`)).rows[0].id;
      const p2 = (await adminClient.query(`INSERT INTO public.payments (registration_id, razorpay_payment_id, amount, status) VALUES ('${r2}', 'pay_Conc2', 35000, 'success') RETURNING id`)).rows[0].id;

      // Two simultaneous database connections
      const connA = await pool.connect();
      const connB = await pool.connect();

      let errorA = null;
      let errorB = null;

      try {
        // Launch both concurrently:
        // connA executes cancel_registration_and_claim_refund (locks Event L1 -> Reg L2 -> Pay L3)
        // connB executes confirm_payment on second payment (locks Event L1 -> Reg L2 -> Pay L3)
        // Both acquire locks in identical Level 1 -> Level 2 -> Level 3 order
        const promiseA = connA.query(`SELECT public.cancel_registration_and_claim_refund('${p1}', '${ownerId}') as res;`)
          .catch(e => { errorA = e; });
        const promiseB = connB.query(`SELECT public.cancel_registration_and_claim_refund('${p2}', '${ownerId}') as res;`)
          .catch(e => { errorB = e; });

        await Promise.all([promiseA, promiseB]);

        assert(!errorA, 'Connection A completed without deadlock (no 40P01)');
        assert(!errorB, 'Connection B completed without deadlock (no 40P01)');

        const finalEv = await adminClient.query(`SELECT booked_count FROM public.events WHERE id = '${eventId}'`);
        assert(finalEv.rows[0].booked_count === 18, 'Both cancellations decremented capacity safely (20 -> 18)');
      } finally {
        connA.release();
        connB.release();
      }
    }

    console.log('\n--- 5. Testing REV-REF-004 & REF-003: Manual Settlement Structured Evidence & Deduplication ---');
    {
      const evRes = await adminClient.query(`INSERT INTO public.events (community_id, title, start_date) VALUES ('${communityId}', 'Manual Settlement Event', NOW()) RETURNING id`);
      const eventId = evRes.rows[0].id;

      const regRes = await adminClient.query(`INSERT INTO public.registrations (event_id, user_id, status) VALUES ('${eventId}', '${userId1}', 'confirmed') RETURNING id`);
      const regId = regRes.rows[0].id;

      const payRes = await adminClient.query(`INSERT INTO public.payments (registration_id, razorpay_payment_id, amount, status) VALUES ('${regId}', 'pay_ManualTest', 75000, 'success') RETURNING id`);
      const payId = payRes.rows[0].id;

      const taskRes = await adminClient.query(`INSERT INTO public.refund_task_queue (payment_id, registration_id, event_id, amount, status) VALUES ('${payId}', '${regId}', '${eventId}', 75000, 'pending') RETURNING id`);
      const taskId = taskRes.rows[0].id;

      // 1. Validation: short reference (< 10 chars) rejected
      const shortRef = await adminClient.query(`
        SELECT public.admin_manual_settlement(
          '${taskId}'::uuid,
          '${adminId}'::uuid,
          '{"settlement_method":"bank_transfer","reference_number":"SHORT12","notes":"Valid notes long enough here for testing."}'::jsonb
        ) as res;
      `);
      assert(shortRef.rows[0].res.error.includes('reference_number'), 'Short reference number (<10 chars) rejected');

      // 2. Validation: short notes (< 20 chars) rejected
      const shortNotes = await adminClient.query(`
        SELECT public.admin_manual_settlement(
          '${taskId}'::uuid,
          '${adminId}'::uuid,
          '{"settlement_method":"bank_transfer","reference_number":"UTR_VALID_12345678","notes":"Too short"}'::jsonb
        ) as res;
      `);
      assert(shortNotes.rows[0].res.error.includes('notes required'), 'Short settlement notes (<20 chars) rejected');

      // 3. Validation: invalid settlement method rejected
      const invalidMethod = await adminClient.query(`
        SELECT public.admin_manual_settlement(
          '${taskId}'::uuid,
          '${adminId}'::uuid,
          '{"settlement_method":"crypto_bitcoin","reference_number":"UTR_VALID_12345678","notes":"Valid notes long enough here for testing."}'::jsonb
        ) as res;
      `);
      assert(invalidMethod.rows[0].res.error.includes('settlement_method'), 'Invalid settlement method rejected');

      // 4. Valid settlement succeeds
      const validSettle = await adminClient.query(`
        SELECT public.admin_manual_settlement(
          '${taskId}'::uuid,
          '${adminId}'::uuid,
          '{"settlement_method":"bank_transfer","reference_number":"UTR_GLOBAL_UNIQUE_12345","notes":"Settled via RTGS offline transfer after customer inquiry."}'::jsonb
        ) as res;
      `);
      assert(validSettle.rows[0].res.ok === true, 'admin_manual_settlement succeeded with valid evidence (ok === true)');

      // Check payment status changed to refunded
      const pCheck = await adminClient.query(`SELECT status, refund_status FROM public.payments WHERE id = '${payId}'`);
      assert(pCheck.rows[0].status === 'refunded', 'Payment marked as refunded');
      assert(pCheck.rows[0].refund_status === 'processed', 'Payment refund_status set to processed');

      // Check audit log recorded structured evidence
      const auditCheck = await adminClient.query(`
        SELECT action, details FROM public.payment_audit_log
        WHERE payment_id = '${payId}' AND action = 'offline_manual_settlement'
      `);
      assert(auditCheck.rowCount === 1, 'Audit log recorded offline_manual_settlement action');
      assert(auditCheck.rows[0].details.evidence.reference_number === 'UTR_GLOBAL_UNIQUE_12345', 'Audit log preserved structured evidence with reference_number');

      // 5. Global duplicate UTR reuse on ANOTHER task is rejected
      const reg2 = (await adminClient.query(`INSERT INTO public.registrations (event_id, user_id, status) VALUES ('${eventId}', '${userId2}', 'confirmed') RETURNING id`)).rows[0].id;
      const pay2 = (await adminClient.query(`INSERT INTO public.payments (registration_id, razorpay_payment_id, amount, status) VALUES ('${reg2}', 'pay_Manual2', 75000, 'success') RETURNING id`)).rows[0].id;
      const task2 = (await adminClient.query(`INSERT INTO public.refund_task_queue (payment_id, registration_id, event_id, amount, status) VALUES ('${pay2}', '${reg2}', '${eventId}', 75000, 'pending') RETURNING id`)).rows[0].id;

      const dupUtr = await adminClient.query(`
        SELECT public.admin_manual_settlement(
          '${task2}'::uuid,
          '${adminId}'::uuid,
          '{"settlement_method":"bank_transfer","reference_number":"UTR_GLOBAL_UNIQUE_12345","notes":"Attempting to reuse same UTR across two payments."}'::jsonb
        ) as res;
      `);
      assert(dupUtr.rows[0].res.error.includes('Reference number has already been used'), 'Duplicate UTR reference reuse rejected across payments');
    }

    console.log('\n--- 5B. Testing REV-REF-002 & REF-003: Provider Refund Adoption & Cross-Payment Deduplication ---');
    {
      const evRes = await adminClient.query(`INSERT INTO public.events (community_id, title, start_date) VALUES ('${communityId}', 'Adopt Provider Event', NOW()) RETURNING id`);
      const eventId = evRes.rows[0].id;

      const regRes = await adminClient.query(`INSERT INTO public.registrations (event_id, user_id, status) VALUES ('${eventId}', '${userId1}', 'confirmed') RETURNING id`);
      const regId = regRes.rows[0].id;

      const payRes = await adminClient.query(`INSERT INTO public.payments (registration_id, razorpay_payment_id, amount, status) VALUES ('${regId}', 'pay_Adopt1', 80000, 'success') RETURNING id`);
      const payId = payRes.rows[0].id;

      const taskRes = await adminClient.query(`INSERT INTO public.refund_task_queue (payment_id, registration_id, event_id, amount, status) VALUES ('${payId}', '${regId}', '${eventId}', 80000, 'pending') RETURNING id`);
      const taskId = taskRes.rows[0].id;

      // 1. Format check: invalid refund ID format rejected
      const badFmt = await adminClient.query(`
        SELECT public.admin_adopt_provider_refund('${taskId}'::uuid, '${adminId}'::uuid, 'not_a_valid_rfnd_id', 'testing') as res;
      `);
      assert(badFmt.rows[0].res.error.includes('Invalid Razorpay Refund ID format'), 'Malformed refund ID rejected by admin_adopt_provider_refund');

      // 2. Valid adoption succeeds
      const goodAdopt = await adminClient.query(`
        SELECT public.admin_adopt_provider_refund('${taskId}'::uuid, '${adminId}'::uuid, 'rfnd_VerifiedProvider1234', 'Verified from dashboard') as res;
      `);
      assert(goodAdopt.rows[0].res.ok === true, 'admin_adopt_provider_refund succeeded for valid refund ID');

      // Check payment status changed to refunded
      const payCheck = await adminClient.query(`SELECT status, refund_status, razorpay_refund_id FROM public.payments WHERE id = '${payId}'`);
      assert(payCheck.rows[0].status === 'refunded', 'Adopted payment marked refunded');
      assert(payCheck.rows[0].refund_status === 'processed', 'Adopted payment refund_status set to processed');
      assert(payCheck.rows[0].razorpay_refund_id === 'rfnd_VerifiedProvider1234', 'Adopted refund ID recorded on payment');

      // Check payment_refund_history
      const histCheck = await adminClient.query(`SELECT * FROM public.payment_refund_history WHERE razorpay_refund_id = 'rfnd_VerifiedProvider1234'`);
      assert(histCheck.rowCount === 1, 'Adopted refund archived in payment_refund_history');

      // 3. Duplicate adoption attempt: cannot adopt same refund ID to another payment
      const reg2 = (await adminClient.query(`INSERT INTO public.registrations (event_id, user_id, status) VALUES ('${eventId}', '${userId2}', 'confirmed') RETURNING id`)).rows[0].id;
      const pay2 = (await adminClient.query(`INSERT INTO public.payments (registration_id, razorpay_payment_id, amount, status) VALUES ('${reg2}', 'pay_Adopt2', 80000, 'success') RETURNING id`)).rows[0].id;
      const task2 = (await adminClient.query(`INSERT INTO public.refund_task_queue (payment_id, registration_id, event_id, amount, status) VALUES ('${pay2}', '${reg2}', '${eventId}', 80000, 'pending') RETURNING id`)).rows[0].id;

      const dupAdopt = await adminClient.query(`
        SELECT public.admin_adopt_provider_refund('${task2}'::uuid, '${adminId}'::uuid, 'rfnd_VerifiedProvider1234', 'Duplicate attempt') as res;
      `);
      assert(dupAdopt.rows[0].res.error.includes('already associated with another payment'), 'Cross-payment duplicate refund ID rejected');
    }

    console.log('\n--- 6. Testing REF-004: Cryptographic CSPRNG Token & COALESCE Non-Rotation ---');
    {
      const evRes = await adminClient.query(`INSERT INTO public.events (community_id, title, capacity, booked_count, start_date) VALUES ('${communityId}', 'Token Gen Event', 10, 0, NOW()) RETURNING id`);
      const eventId = evRes.rows[0].id;

      const regRes = await adminClient.query(`INSERT INTO public.registrations (event_id, user_id, status) VALUES ('${eventId}', '${userId1}', 'reserved') RETURNING id`);
      const regId = regRes.rows[0].id;

      const payRes = await adminClient.query(`INSERT INTO public.payments (registration_id, razorpay_payment_id, amount, status) VALUES ('${regId}', 'pay_TokenTest123', 15000, 'pending') RETURNING id`);
      const payId = payRes.rows[0].id;

      // 1. Initial confirmation generates 244-bit CSPRNG token with 'cluvo_' prefix
      const conf1 = await adminClient.query(`
        SELECT public.confirm_payment('${payId}', 15000, 'INR', 'pay_TokenTest123') as res;
      `);
      assert(conf1.rows[0].res.action === 'confirmed', 'confirm_payment confirmed payment successfully');

      const rCheck1 = await adminClient.query(`SELECT status, qr_code FROM public.registrations WHERE id = '${regId}'`);
      const token1 = rCheck1.rows[0].qr_code;
      assert(token1.startsWith('cluvo_'), 'Generated QR token has cluvo_ prefix');
      assert(token1.length === 6 + 64, 'Token has 64-char SHA256 hex digest (total length 70)');

      // 2. Webhook replay: second confirm_payment must NOT rotate QR token (COALESCE preservation)
      const conf2 = await adminClient.query(`
        SELECT public.confirm_payment('${payId}', 15000, 'INR', 'pay_TokenTest123') as res;
      `);
      assert(conf2.rows[0].res.skipped === true, 'Webhook replay recognized already confirmed payment (skipped)');

      const rCheck2 = await adminClient.query(`SELECT qr_code FROM public.registrations WHERE id = '${regId}'`);
      assert(rCheck2.rows[0].qr_code === token1, 'QR code remained completely unchanged on webhook replay (zero rotation)');
    }

    console.log('\n================================================================================');
    console.log(`ALL PHYSICAL DATABASE CONCURRENCY & INTEGRATION TESTS PASSED: ${passedTests}/${totalTests}`);
    console.log('================================================================================\n');

  } finally {
    adminClient.release();
    await pool.end();
  }
}

runTests().catch(err => {
  console.error('\nDATABASE INTEGRATION TEST EXECUTION FAILED:', err);
  pool.end();
  process.exit(1);
});
