/**
 * CLUVO STAGE 6: MANUAL SETTLEMENT POSTGRESQL CONCURRENCY & INTEGRATION TEST
 *
 * Exhaustive real-database verification suite:
 * 1. Two simultaneous confirmations of one payout (TOCTOU double-debit prevention)
 * 2. Confirmation racing against dispute
 * 3. Admin dispute resolution racing against organizer actions
 * 4. Sequential duplicate confirmation
 * 5. Duplicate settlement submission (same UTR collision)
 * 6. Concurrent admin over-allocation (wallet level)
 * 7. Event-level over-allocation (net revenue limit)
 * 8. Legitimate partial payout
 * 9. Multi-event allocation with single external UTR
 * 10. Atomic transaction rollback
 * 11. Cancelled disputed payout releasing reserved balance
 * 12. Full ledger and wallet reconciliation
 */

const { Pool, Client } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://shivapraneeth@localhost:5432/cluvo_test_stage6';

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
  console.log('\n--- 1. Setting up Isolated Test Schema & Functions ---');

  await client.query(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

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

    -- Auth schema & context mock
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid()
    );

    -- Profiles
    CREATE TABLE IF NOT EXISTS public.profiles (
      id UUID PRIMARY KEY,
      email TEXT,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      is_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    ALTER TABLE public.profiles DROP COLUMN IF EXISTS phone;
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS first_name TEXT;
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_name TEXT;
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username TEXT;
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

    -- Communities
    CREATE TABLE IF NOT EXISTS public.communities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES public.profiles(id),
      name TEXT NOT NULL,
      wallet_balance INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    ALTER TABLE public.communities ADD COLUMN IF NOT EXISTS wallet_balance INTEGER NOT NULL DEFAULT 0;

    -- Beneficiaries
    CREATE TABLE IF NOT EXISTS public.community_beneficiaries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      community_id UUID NOT NULL REFERENCES public.communities(id),
      account_holder TEXT NOT NULL,
      bank_account_number TEXT NOT NULL,
      bank_ifsc TEXT NOT NULL,
      label TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Events
    CREATE TABLE IF NOT EXISTS public.events (
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
    CREATE TABLE IF NOT EXISTS public.registrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES public.events(id),
      user_id UUID REFERENCES public.profiles(id),
      status TEXT NOT NULL DEFAULT 'confirmed',
      created_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Payments
    CREATE TABLE IF NOT EXISTS public.payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      registration_id UUID NOT NULL REFERENCES public.registrations(id),
      razorpay_payment_id TEXT,
      razorpay_order_id TEXT,
      amount INTEGER NOT NULL,
      platform_fee INTEGER DEFAULT 0,
      organizer_share INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'success',
      created_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Payment Refund History
    CREATE TABLE IF NOT EXISTS public.payment_refund_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      registration_id UUID NOT NULL REFERENCES public.registrations(id),
      payment_id UUID NOT NULL REFERENCES public.payments(id),
      event_id UUID NOT NULL REFERENCES public.events(id),
      amount INTEGER NOT NULL,
      payment_amount INTEGER,
      platform_fee INTEGER DEFAULT 0,
      refund_reason TEXT,
      refund_status TEXT DEFAULT 'processed',
      razorpay_refund_id TEXT,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Payout Items
    CREATE TABLE IF NOT EXISTS public.payout_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      community_id UUID NOT NULL REFERENCES public.communities(id),
      event_id UUID REFERENCES public.events(id) ON DELETE SET NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL DEFAULT 'pending_confirmation'
        CHECK (status IN ('pending', 'processing', 'success', 'failed', 'pending_confirmation', 'disputed', 'cancelled')),
      utr TEXT,
      beneficiary_id UUID REFERENCES public.community_beneficiaries(id) ON DELETE SET NULL,
      payment_method TEXT DEFAULT 'IMPS',
      admin_notes TEXT,
      dispute_reason TEXT,
      recorded_by_admin UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
      confirmed_by_user UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
      confirmed_at TIMESTAMPTZ,
      resolved_by_admin UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
      resolved_at TIMESTAMPTZ,
      resolution_notes TEXT,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    -- Audit Log
    CREATE TABLE IF NOT EXISTS public.payment_audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id UUID,
      action TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT clock_timestamp()
    );

    ALTER TABLE public.payment_audit_log ALTER COLUMN payment_id DROP NOT NULL;

    -- Deduplication unique index
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_items_active_transfer
      ON public.payout_items (
        community_id,
        COALESCE(event_id, '00000000-0000-0000-0000-000000000000'::UUID),
        UPPER(TRIM(utr))
      )
      WHERE status IN ('pending_confirmation', 'success');

    -- Clean existing test rows
    TRUNCATE public.payout_items, public.payment_audit_log, public.payment_refund_history, public.payments, public.registrations, public.events, public.community_beneficiaries, public.communities, public.profiles CASCADE;

    -- Auth helpers
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
    $$ LANGUAGE sql STABLE;

    CREATE OR REPLACE FUNCTION public.is_admin_user() RETURNS BOOLEAN AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND p.is_admin = true
      );
    $$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '';

    CREATE OR REPLACE FUNCTION public.is_community_owner(community_id UUID) RETURNS BOOLEAN AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.communities c
        WHERE c.id = community_id AND c.owner_id = auth.uid()
      );
    $$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '';
  `);

    // Deploy functions from migration 202611010017
    const fs = require('fs');
    const path = require('path');
    
    // Fix: Deploy foundational RPCs first (that reference razorpay_order_id)
    const mig05 = fs.readFileSync(path.join(__dirname, '../supabase/migrations/202610300005_admin_profiles_rpc_and_fix_ledger.sql'), 'utf-8');
    await client.query(mig05);
    
    const migrationSql = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/202611010017_concurrency_safe_manual_settlements.sql'),
      'utf-8'
    );
    await client.query(migrationSql);
    console.log('Schema and Migrations 202610300005 & 202611010017 deployed successfully.');
}

async function runTests() {
  const masterClient = await pool.connect();

  try {
    await setupSchema(masterClient);

    const adminId = '11111111-1111-4111-8111-111111111111';
    const orgId = '22222222-2222-4222-8222-222222222222';
    const otherOrgId = '33333333-3333-4333-8333-333333333333';
    const commId = '44444444-4444-4444-8444-444444444444';
    const eventId1 = '55555555-5555-4555-8555-555555555551';
    const eventId2 = '55555555-5555-4555-8555-555555555552';

    // Insert base fixtures
    await masterClient.query(`
      INSERT INTO public.profiles (id, email, is_admin) VALUES
        ('${adminId}', 'admin@cluvo.com', true),
        ('${orgId}', 'organizer@cluvo.com', false),
        ('${otherOrgId}', 'other@cluvo.com', false)
      ON CONFLICT (id) DO UPDATE SET is_admin = EXCLUDED.is_admin;

      INSERT INTO public.communities (id, owner_id, name, wallet_balance) VALUES
        ('${commId}', '${orgId}', 'Stage 6 Settlement Community', 200000)
      ON CONFLICT (id) DO UPDATE SET wallet_balance = 200000;

      INSERT INTO public.community_beneficiaries (community_id, account_holder, bank_account_number, bank_ifsc) VALUES
        ('${commId}', 'Acme Organizer', '1234567890', 'HDFC0001234')
      ON CONFLICT DO NOTHING;

      INSERT INTO public.events (id, community_id, title) VALUES
        ('${eventId1}', '${commId}', 'Tech Conference 2026'),
        ('${eventId2}', '${commId}', 'AI Workshop 2026')
      ON CONFLICT DO NOTHING;
    `);

    // Helper to run query as a specific user
    const asUser = async (client, userId, query, params = []) => {
      await client.query(`SET "request.jwt.claim.sub" = '${userId}'`);
      return client.query(query, params);
    };

    // ========================================================================
    // TEST 1: Two Simultaneous Confirmations of One Payout (Double-Debit Fix)
    // ========================================================================
    console.log('\n--- TEST 1: Simultaneous Confirmations of One Payout ---');
    {
      // Reset wallet to 100,000 paise (₹1,000)
      await masterClient.query(`UPDATE public.communities SET wallet_balance = 100000 WHERE id = '${commId}'`);

      // Record payout of 40,000 paise (₹400)
      const recRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 40000, 'UTR-CONCUR-001', 'IMPS', null, 'Concur test']
      );
      if (!recRes.rows[0].res.ok) {
        console.error('Record manual payout failed:', recRes.rows[0].res);
      }
      const payoutId = recRes.rows[0].res.payout_id;
      assert(payoutId, 'Payout successfully recorded');

      // Launch two competing client connections simultaneously
      const runConfirm = async () => {
        const client = await pool.connect();
        try {
          await client.query(`SET "request.jwt.claim.sub" = '${orgId}'`);
          const res = await client.query(`SELECT public.organizer_confirm_manual_payout($1) as res`, [payoutId]);
          return res.rows[0].res;
        } finally {
          client.release();
        }
      };

      const [outcome1, outcome2] = await Promise.all([runConfirm(), runConfirm()]);

      const successCount = (outcome1.ok ? 1 : 0) + (outcome2.ok ? 1 : 0);
      const failureCount = (!outcome1.ok ? 1 : 0) + (!outcome2.ok ? 1 : 0);

      assert(successCount === 1, `Exactly one confirmation succeeded (successCount: ${successCount})`);
      assert(failureCount === 1, `Exactly one confirmation failed cleanly (failureCount: ${failureCount})`);

      const failedOutcome = !outcome1.ok ? outcome1 : outcome2;
      assert(
        failedOutcome.error === 'invalid_payout_status',
        `Second confirmation rejected with invalid_payout_status: ${failedOutcome.message}`
      );

      // Check wallet balance: 100,000 - 40,000 = exactly 60,000
      const balRes = await masterClient.query(`SELECT wallet_balance FROM public.communities WHERE id = '${commId}'`);
      assert(balRes.rows[0].wallet_balance === 60000, `Wallet balance debited exactly once: ${balRes.rows[0].wallet_balance} paise`);

      // Check audit log count
      const auditRes = await masterClient.query(
        `SELECT COUNT(*) FROM public.payment_audit_log WHERE action = 'wallet_debited' AND details->>'payout_id' = '${payoutId}'`
      );
      assert(parseInt(auditRes.rows[0].count) === 1, `Exactly 1 wallet_debited audit entry recorded`);
    }

    // ========================================================================
    // TEST 2: Confirmation Racing Against Dispute
    // ========================================================================
    console.log('\n--- TEST 2: Confirmation Racing Against Dispute ---');
    {
      await masterClient.query(`UPDATE public.communities SET wallet_balance = 100000 WHERE id = '${commId}'`);

      const recRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 30000, 'UTR-RACE-CONF-DISP', 'IMPS', null, 'Race test']
      );
      const payoutId = recRes.rows[0].res.payout_id;

      // Client 1 (Confirm) and Client 2 (Dispute) racing concurrently
      const runConfirm = async () => {
        const client = await pool.connect();
        try {
          await client.query(`SET "request.jwt.claim.sub" = '${orgId}'`);
          const res = await client.query(`SELECT public.organizer_confirm_manual_payout($1) as res`, [payoutId]);
          return res.rows[0].res;
        } finally {
          client.release();
        }
      };

      const runDispute = async () => {
        const client = await pool.connect();
        try {
          await client.query(`SET "request.jwt.claim.sub" = '${orgId}'`);
          const res = await client.query(`SELECT public.organizer_dispute_manual_payout($1, $2) as res`, [payoutId, 'Funds not seen']);
          return res.rows[0].res;
        } finally {
          client.release();
        }
      };

      const [confirmRes, disputeRes] = await Promise.all([runConfirm(), runDispute()]);

        assert(
          (confirmRes.ok && !disputeRes.ok) || (!confirmRes.ok && disputeRes.ok),
          `Exactly one operation won the race (Confirm ok: ${confirmRes.ok}, Dispute ok: ${disputeRes.ok})`
        );

        const statusRes = await masterClient.query(`SELECT status FROM public.payout_items WHERE id = '${payoutId}'`);
        const finalStatus = statusRes.rows[0].status;
        assert(finalStatus === 'success' || finalStatus === 'disputed', `Final status is consistent: ${finalStatus}`);

        if (finalStatus === 'success') {
          assert(!disputeRes.ok && disputeRes.error === 'invalid_payout_status', 'Dispute rejected because payout was already confirmed');
        } else {
          assert(!confirmRes.ok && confirmRes.error === 'invalid_payout_status', 'Confirm rejected because payout was already disputed');
        }
    }

    // ========================================================================
    // TEST 3: Admin Dispute Resolution Racing Against Organizer
    // ========================================================================
    console.log('\n--- TEST 3: Admin Dispute Resolution Racing Against Organizer Action ---');
    {
      const recRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 25000, 'UTR-DISP-RES-RACE', 'IMPS', null, 'Dispute resolution race']
      );
      const payoutId = recRes.rows[0].res.payout_id;

      // Dispute it first
      await asUser(masterClient, orgId, `SELECT public.organizer_dispute_manual_payout($1, $2)`, [payoutId, 'Wrong bank details']);

      const runAdminResolve = async () => {
        const client = await pool.connect();
        try {
          await client.query(`SET "request.jwt.claim.sub" = '${adminId}'`);
          const res = await client.query(`SELECT public.admin_resolve_payout_dispute($1, $2, $3) as res`, [
            payoutId,
            'cancel_disputed_payout',
            'Confirmed external transfer failed at bank',
          ]);
          return res.rows[0].res;
        } finally {
          client.release();
        }
      };

      const runOrgConfirm = async () => {
        const client = await pool.connect();
        try {
          await client.query(`SET "request.jwt.claim.sub" = '${orgId}'`);
          const res = await client.query(`SELECT public.organizer_confirm_manual_payout($1) as res`, [payoutId]);
          return res.rows[0].res;
        } finally {
          client.release();
        }
      };

      const [adminOutcome, orgOutcome] = await Promise.all([runAdminResolve(), runOrgConfirm()]);

        assert(adminOutcome.ok === true && adminOutcome.status === 'cancelled', 'Admin resolution succeeded and cancelled the payout');
        assert(orgOutcome.ok === false, 'Organizer confirm failed on disputed/cancelled record');
    }

    // ========================================================================
    // TEST 4: Sequential Duplicate Confirmation
    // ========================================================================
    console.log('\n--- TEST 4: Sequential Duplicate Confirmation ---');
    {
      const recRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 15000, 'UTR-SEQ-DUP-CONF', 'IMPS', null, 'Sequential dup test']
      );
      const payoutId = recRes.rows[0].res.payout_id;

      const call1 = await asUser(masterClient, orgId, `SELECT public.organizer_confirm_manual_payout($1) as res`, [payoutId]);
      assert(call1.rows[0].res.ok === true, 'First sequential confirmation succeeded');

      const call2 = await asUser(masterClient, orgId, `SELECT public.organizer_confirm_manual_payout($1) as res`, [payoutId]);
      assert(call2.rows[0].res.ok === false && call2.rows[0].res.error === 'invalid_payout_status', 'Second sequential confirmation rejected');
    }

    // ========================================================================
    // TEST 5: Duplicate Settlement Submission (Same UTR Collision)
    // ========================================================================
    console.log('\n--- TEST 5: Duplicate Settlement Submission ---');
    {
      const utr = 'UTR-UNIQUE-TEST-99';
      const sub1 = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 10000, utr, 'IMPS', null, 'First sub']
      );
      assert(sub1.rows[0].res.ok === true, 'First payout submission with UTR succeeded');

      // Attempt duplicate submission with whitespace/case variation
      const sub2 = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 10000, `  ${utr.toLowerCase()}  `, 'IMPS', null, 'Second sub duplicate']
      );
      assert(sub2.rows[0].res.ok === false && sub2.rows[0].res.error === 'duplicate_payout_utr', 'Duplicate UTR submission rejected with duplicate_payout_utr');
    }

    // ========================================================================
    // TEST 6: Concurrent Admin Over-Allocation (Wallet Level)
    // ========================================================================
    console.log('\n--- TEST 6: Concurrent Admin Wallet Over-Allocation ---');
    {
      await masterClient.query(`UPDATE public.communities SET wallet_balance = 50000 WHERE id = '${commId}'`);

      const runAdminPayout = async (utr, note) => {
        const client = await pool.connect();
        try {
          await client.query(`SET "request.jwt.claim.sub" = '${adminId}'`);
          const res = await client.query(
            `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
            [commId, 40000, utr, 'IMPS', null, note]
          );
          return res.rows[0].res;
        } finally {
          client.release();
        }
      };

      const [res1, res2] = await Promise.all([
        runAdminPayout('UTR-OVERALLOC-A', 'Admin A'),
        runAdminPayout('UTR-OVERALLOC-B', 'Admin B'),
      ]);

        const successCount = (res1.ok ? 1 : 0) + (res2.ok ? 1 : 0);
        assert(successCount === 1, `Exactly one admin allocation succeeded (successCount: ${successCount})`);

        const failedRes = !res1.ok ? res1 : res2;
        assert(
          failedRes.error === 'insufficient_uncommitted_balance',
          `Second admin rejected with insufficient_uncommitted_balance: ${failedRes.message}`
        );
    }

    // ========================================================================
    // TEST 7: Event-Level Over-Allocation Enforcement
    // ========================================================================
    console.log('\n--- TEST 7: Event-Level Over-Allocation Enforcement ---');
    {
      // Setup event 1 sales: 1 ticket sold at 50,000 paise, platform fee 3,000, organizer share 47,000
      const regId = '66666666-6666-4666-8666-666666666661';
      const payId = '77777777-7777-4777-8777-777777777771';

      await masterClient.query(`
        INSERT INTO public.registrations (id, event_id, status) VALUES ('${regId}', '${eventId1}', 'confirmed')
        ON CONFLICT DO NOTHING;
        INSERT INTO public.payments (id, registration_id, amount, platform_fee, organizer_share, status) VALUES
          ('${payId}', '${regId}', 50000, 3000, 47000, 'success')
        ON CONFLICT DO NOTHING;
      `);

      // Ensure community wallet has plenty of funds (200,000)
      await masterClient.query(`UPDATE public.communities SET wallet_balance = 200000 WHERE id = '${commId}'`);

      // Attempt to record 48,000 paise against Event 1 (net sales = 47,000)
      const overRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 48000, 'UTR-EVENT-OVER', 'IMPS', eventId1, 'Event overalloc test']
      );

      assert(overRes.rows[0].res.ok === false, 'Event-level over-allocation was rejected');
      assert(
        overRes.rows[0].res.error === 'insufficient_event_payable_balance',
        `Correct error returned: ${overRes.rows[0].res.error} (${overRes.rows[0].res.message})`
      );

      // Attempt legitimate allocation of 45,000 paise <= 47,000
      const validRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 45000, 'UTR-EVENT-VALID', 'IMPS', eventId1, 'Event valid test']
      );
      assert(validRes.rows[0].res.ok === true, 'Legitimate event allocation within net revenue succeeded');
    }

    // ========================================================================
    // TEST 8: Legitimate Partial Payout
    // ========================================================================
    console.log('\n--- TEST 8: Legitimate Partial Payout ---');
    {
      // Event 1 has 47,000 gross earned, 45,000 locked from Test 7, so remaining is 2,000
      // Request partial 1,500
      const partialRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 1500, 'UTR-EVENT-PARTIAL', 'IMPS', eventId1, 'Partial payout test']
      );
      assert(partialRes.rows[0].res.ok === true, 'Partial event payout of 1,500 paise succeeded');

      // Now only 500 remaining. Requesting 600 should fail
      const exceedRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 600, 'UTR-EVENT-EXCEED-PARTIAL', 'IMPS', eventId1, 'Exceed partial test']
      );
      assert(exceedRes.rows[0].res.ok === false, 'Subsequent request exceeding remaining event balance rejected');
    }

    // ========================================================================
    // TEST 9: Multi-Event Allocation with Single External UTR
    // ========================================================================
    console.log('\n--- TEST 9: Multi-Event Allocation with Single External UTR ---');
    {
      // Give Event 2 some sales
      const regId2 = '66666666-6666-4666-8666-666666666662';
      const payId2 = '77777777-7777-4777-8777-777777777772';
      await masterClient.query(`
        INSERT INTO public.registrations (id, event_id, status) VALUES ('${regId2}', '${eventId2}', 'confirmed')
        ON CONFLICT DO NOTHING;
        INSERT INTO public.payments (id, registration_id, amount, platform_fee, organizer_share, status) VALUES
          ('${payId2}', '${regId2}', 80000, 4800, 75200, 'success')
        ON CONFLICT DO NOTHING;
      `);

      const singleUtr = 'CORP-WIRE-COMBINED-001';

      // Record for Event 2
      const alloc1 = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 30000, singleUtr, 'RTGS', eventId2, 'Multi-event split 1']
      );
      assert(alloc1.rows[0].res.ok === true, 'First event allocation with shared UTR succeeded');

      // Record second allocation with SAME UTR for Event 2 should fail (same event duplicate)
      const dupSameEvent = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 10000, singleUtr, 'RTGS', eventId2, 'Dup same event']
      );
      assert(dupSameEvent.rows[0].res.ok === false, 'Duplicate UTR on same event rejected');

      // Record second allocation with SAME UTR for wallet-wide (null event)
      const alloc2 = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 20000, singleUtr, 'RTGS', null, 'Multi-event split 2 general']
      );
      assert(alloc2.rows[0].res.ok === true, 'Second allocation with shared UTR across distinct scope succeeded');
    }

    // ========================================================================
    // TEST 10: Atomic Transaction Rollback on Error
    // ========================================================================
    console.log('\n--- TEST 10: Atomic Transaction Rollback on Error ---');
    {
      const startBalRes = await masterClient.query(`SELECT wallet_balance FROM public.communities WHERE id = '${commId}'`);
      const startBalance = startBalRes.rows[0].wallet_balance;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL "request.jwt.claim.sub" = '${adminId}'`);

        // Record a payout
        const rec = await client.query(
          `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
          [commId, 5000, 'UTR-ROLLBACK-TEST', 'IMPS', null, 'Rollback test']
        );
        assert(rec.rows[0].res.ok === true, 'Payout recorded in transaction');

        // Intentionally throw an error
        await client.query('SELECT 1 / 0');
      } catch (err) {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      // Verify that UTR-ROLLBACK-TEST was rolled back
      const checkRes = await masterClient.query(
        `SELECT COUNT(*) FROM public.payout_items WHERE utr = 'UTR-ROLLBACK-TEST'`
      );
      assert(parseInt(checkRes.rows[0].count) === 0, 'Rolled back payout item does not exist in database');

      const endBalRes = await masterClient.query(`SELECT wallet_balance FROM public.communities WHERE id = '${commId}'`);
      assert(endBalRes.rows[0].wallet_balance === startBalance, 'Wallet balance completely preserved after rollback');
    }

    // ========================================================================
    // TEST 11: Cancelled Disputed Payout Releases Reserved Balance
    // ========================================================================
    console.log('\n--- TEST 11: Cancelled Disputed Payout Releases Reserved Balance ---');
    {
      await masterClient.query(`DELETE FROM public.payout_items WHERE community_id = '${commId}'`);
      await masterClient.query(`UPDATE public.communities SET wallet_balance = 50000 WHERE id = '${commId}'`);

      // Record payout of 40,000 paise
      const rec = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 40000, 'UTR-CANCEL-TEST', 'IMPS', null, 'Cancel test']
      );
      assert(rec.rows[0].res.ok === true, 'Test 11 payout recorded successfully');
      const payoutId = rec.rows[0].res.payout_id;

      // Dispute it
      const dispRes = await asUser(masterClient, orgId, `SELECT public.organizer_dispute_manual_payout($1, $2) as res`, [payoutId, 'External transfer failed']);
      assert(dispRes.rows[0].res.ok === true, 'Dispute filed successfully');

      // At this point, 40,000 is locked, only 10,000 uncommitted
      // Attempting to record 20,000 must fail
      const blockedRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 20000, 'UTR-SHOULD-FAIL', 'IMPS', null, 'Should fail']
      );
      assert(blockedRes.rows[0].res.ok === false, 'New payout blocked while disputed settlement is active');

      // Admin cancels the disputed payout
      const cancelRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_resolve_payout_dispute($1, $2, $3) as res`,
        [payoutId, 'cancel_disputed_payout', 'External bank transfer was refunded to admin corporate account']
      );
      assert(cancelRes.rows[0].res.ok === true && cancelRes.rows[0].res.status === 'cancelled', 'Admin successfully cancelled disputed payout');

      // Now 40,000 reservation is freed! Uncommitted balance is back to 50,000. Recording 20,000 should now succeed!
      const unblockedRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 20000, 'UTR-NOW-SUCCEEDS', 'IMPS', null, 'Now succeeds']
      );
      assert(unblockedRes.rows[0].res.ok === true, 'New payout succeeded after disputed reservation was released');
    }

    // ========================================================================
    // TEST 12: Admin Cancellation of Pending Payout
    // ========================================================================
    console.log('\n--- TEST 12: Admin Cancellation of Pending Payout ---');
    {
      await masterClient.query(`DELETE FROM public.payout_items WHERE community_id = '${commId}'`);
      await masterClient.query(`UPDATE public.communities SET wallet_balance = 50000 WHERE id = '${commId}'`);

      const rec = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 10000, 'UTR-ADMIN-CANCEL-PEND', 'IMPS', null, 'Typo in UTR']
      );
      assert(rec.rows[0].res.ok === true, 'Pending payout recorded');
      const payoutId = rec.rows[0].res.payout_id;

      const cancelRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_cancel_manual_payout($1, $2) as res`,
        [payoutId, 'Typo in bank account number; cancelling to re-record']
      );
      assert(cancelRes.rows[0].res.ok === true && cancelRes.rows[0].res.status === 'cancelled', 'Admin successfully cancelled pending payout');

      // Verify status is cancelled
      const statusRes = await masterClient.query(`SELECT status, resolution_notes FROM public.payout_items WHERE id = '${payoutId}'`);
      assert(statusRes.rows[0].status === 'cancelled', 'Payout status is cancelled');
      assert(statusRes.rows[0].resolution_notes.includes('Typo in bank account'), 'Cancellation reason recorded in resolution_notes');
    }

    // ========================================================================
    // TEST 13: Non-Admin & Cross-Organizer Authorization Security
    // ========================================================================
    console.log('\n--- TEST 13: Security and Authorization Boundaries ---');
    {
      await masterClient.query(`DELETE FROM public.payout_items WHERE community_id = '${commId}'`);
      await masterClient.query(`UPDATE public.communities SET wallet_balance = 50000 WHERE id = '${commId}'`);

      // Non-admin attempting to record manual payout
      try {
        await asUser(
          masterClient,
          orgId,
          `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
          [commId, 5000, 'UTR-HACK', 'IMPS', null, 'Hack attempt']
        );
        assert(false, 'Non-admin should not be able to record manual payout');
      } catch (err) {
        assert(err.message.includes('Only platform administrators'), 'Non-admin record blocked by PostgreSQL');
      }

      // Non-owner organizer attempting to confirm
      const rec = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 5000, 'UTR-AUTH-TEST', 'IMPS', null, 'Auth test']
      );
      const payoutId = rec.rows[0].res.payout_id;

      const crossConfirm = await asUser(
        masterClient,
        otherOrgId,
        `SELECT public.organizer_confirm_manual_payout($1) as res`,
        [payoutId]
      );
      assert(crossConfirm.rows[0].res.ok === false && crossConfirm.rows[0].res.error.includes('Not authorized'), 'Cross-organizer confirmation blocked');
    }

    // ========================================================================
    // TEST 14: Financial Statements Execution without profiles.phone (VER-MS-001)
    // ========================================================================
    console.log('\n--- TEST 14: Financial Statements Query Execution (VER-MS-001) ---');
    {
      // Check whether phone column exists on profiles in test db
      const colCheck = await masterClient.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'phone'`
      );
      assert(colCheck.rows.length === 0, 'Verified profiles table does not have phone column');

      // Admin financial statement must succeed without SQL column error
      const adminStmt = await asUser(
        masterClient,
        adminId,
        `SELECT * FROM public.get_admin_financial_statement($1)`,
        [commId]
      );
      assert(Array.isArray(adminStmt.rows), 'Admin financial statement executed successfully without column error');
      console.log(`  Admin statement returned ${adminStmt.rows.length} rows`);

      // Organizer financial statement must succeed without SQL column error
      const orgStmt = await asUser(
        masterClient,
        orgId,
        `SELECT * FROM public.get_organizer_financial_statement($1)`,
        [commId]
      );
      assert(Array.isArray(orgStmt.rows), 'Organizer financial statement executed successfully without column error');
      console.log(`  Organizer statement returned ${orgStmt.rows.length} rows`);
    }

    // ========================================================================
    // TEST 15: PostgREST Parameter Contract for admin_cancel_manual_payout (VER-MS-002)
    // ========================================================================
    console.log('\n--- TEST 15: RPC Parameter Signature Verification (VER-MS-002) ---');
    {
      const procRes = await masterClient.query(`
        SELECT proname, proargnames
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND proname = 'admin_cancel_manual_payout'
      `);
      assert(procRes.rows.length > 0, 'admin_cancel_manual_payout exists in pg_proc');
      const argNames = procRes.rows[0].proargnames;
      console.log(`  admin_cancel_manual_payout argument names: [${argNames.join(', ')}]`);
      assert(argNames.includes('p_cancel_reason'), 'RPC signature expects p_cancel_reason (not p_cancellation_notes)');

      // Test RPC invocation using p_cancel_reason
      const rec = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_record_manual_payout($1, $2, $3, $4, $5, $6) as res`,
        [commId, 2000, 'UTR-CANCEL-PARAM-CHECK', 'IMPS', null, 'Param check']
      );
      const pid = rec.rows[0].res.payout_id;

      const cancelRes = await asUser(
        masterClient,
        adminId,
        `SELECT public.admin_cancel_manual_payout(p_payout_id => $1, p_cancel_reason => $2) as res`,
        [pid, 'Testing parameter matching']
      );
      assert(cancelRes.rows[0].res.ok === true && cancelRes.rows[0].res.status === 'cancelled', 'admin_cancel_manual_payout succeeds with p_cancel_reason');
    }

    console.log('\n======================================================');
    console.log(`ALL TESTS PASSED: ${passedTests} / ${totalTests}`);
    console.log('======================================================\n');
  } finally {
    masterClient.release();
    await pool.end();
  }
}

runTests().catch((err) => {
  console.error('\nTEST SUITE FAILED WITH ERROR:', err);
  process.exit(1);
});
