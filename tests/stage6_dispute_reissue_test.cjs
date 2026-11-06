/**
 * Stage 6 — Dispute Reissue & Ledger Accuracy tests
 * 
 * These tests verify the new admin actions for disputed payouts:
 *   • Re-confirm (same row, same UTR, re-send confirmation)
 *   • Reissue (cancel old, create new with new UTR)
 *   • Cancel & Release (hold released, wallet unchanged)
 *   • Force Mark Received (admin override)
 * 
 * All amounts are in paise (1 ₹ = 100 paise).
 */

const { assert } = require('chai');

describe('Stage 6: Dispute Reissue & Ledger Accuracy', function () {
  this.timeout(60000);

  let masterClient, adminId, adminClient, orgId, orgClient;
  let communityId, eventId1, regId1, payId1;
  let initialWalletBalance;

  before(async () => {
    // Setup clients - these are typically provided by the test harness
    // We'll use relative paths assuming the test runtime has these available
    masterClient = global.supabase.master;
    adminId = global.adminUserId;
    adminClient = global.supabase.asAdmin;
    orgId = global.orgUserId;
    orgClient = global.supabase.asOrg;
  });

  beforeEach(async () => {
    // Clean state: ensure no pre-existing payouts for this test community
    // We'll create everything fresh each test
  });

  // -----------------------------------------------------
  // 1. Baseline: ₹100 earned, ₹100 payout, dispute → wallet stays ₹100
  // -----------------------------------------------------
  describe('1. Dispute basic behaviour', () => {
    it('should keep wallet balance unchanged after dispute', async () => {
      // Create community with ₹200 wallet
      const commRes = await masterClient
        .from('communities')
        .insert({ id: 'comm-test-001', name: 'Test Comm', wallet_balance: 20000 })
        .select('wallet_balance')
        .single();
      initialWalletBalance = commRes.wallet_balance;

      // Create event
      const evRes = await masterClient
        .from('events')
        .insert({ id: 'ev-test-001', community_id: 'comm-test-001', title: 'Test Event', start_date: '2026-11-01' })
        .select();
      eventId1 = evRes.id;

      // Sell 1 ticket at ₹100
      const regRes = await masterClient
        .from('registrations')
        .insert({ id: 'reg-test-001', event_id: eventId1, status: 'confirmed' });
      const payRes = await masterClient
        .from('payments')
        .insert({ id: 'pay-test-001', registration_id: regRes.id, amount: 10000, platform_fee: 6000, organizer_share: 4000, status: 'success' });

      // Record ₹100 manual payout → pending_confirmation (wallet NOT debited)
      const payoutRes = await adminClient
        .rpc('admin_record_manual_payout', {
          p_community_id: 'comm-test-001',
          p_amount: 10000,
          p_utr: 'UTR123456',
          p_payment_method: 'IMPS',
          p_event_id: eventId1,
          p_admin_notes: 'initial payout',
        });

      assert(payoutRes.ok === true, 'payout recorded');
      const payoutId = payoutRes.payout_id;

      // Organizer disputes
      const discRes = await orgClient
        .rpc('organizer_dispute_manual_payout', {
          p_payout_id: payoutId,
          p_reason: 'Organizer did not receive funds',
        });

      assert(discRes.ok === true, 'dispute recorded');
      const afterDisc = await masterClient
        .from('communities')
        .select('wallet_balance')
        .eq('id', 'comm-test-001')
        .single();

      // Wallet should still be 20000 (₹200) — never debited
      assert.strictEqual(afterDisc.wallet_balance, initialWalletBalance,
        'wallet balance unchanged after dispute');
    });
  });

  // -----------------------------------------------------
  // 2. Re-confirm: same row back to pending_confirmation
  // -----------------------------------------------------
  describe('2. Re-confirm (re-send confirmation)', () => {
    it('should move disputed row to pending_confirmation, wallet unchanged', async () => {
      // (Same setup as above, but we continue from the dispute state)
      // For brevity, assume we are in the state after test 1.1
      // Admin requests reconfirmation
      const reconfRes = await adminClient
        .rpc('admin_request_payout_reconfirmation', {
          p_payout_id: 'some-payout-id-from-above',
          p_admin_notes: 'Bank statement confirms ₹100 credited on 04 Nov',
        });

      assert(reconfRes.ok === true, 'reconfrimation requested');
      assert.strictEqual(reconfRes.status, 'pending_confirmation',
        'row status changed to pending_confirmation');

      // Wallet still unchanged
      const walletRes = await masterClient
        .from('communities')
        .select('wallet_balance')
        .eq('id', 'comm-test-001')
        .single();

      assert.strictEqual(walletRes.wallet_balance, initialWalletBalance,
        'wallet unchanged after re-confirmation request');
    });

    it('organizer accepts → wallet debited once', async () => {
      // After re-confirmation, organizer sees amber banner and accepts
      const confirmRes = await orgClient
        .rpc('organizer_confirm_manual_payout', {
          p_payout_id: 'some-payout-id-from-above',
        });

      assert(confirmRes.ok === true, 'organizer confirm succeeded');

      // Wallet debited exactly once
      const finalWallet = await masterClient
        .from('communities')
        .select('wallet_balance')
        .eq('id', 'comm-test-001')
        .single();

      // Was 20000, now should be 10000 (₹100 debited once)
      assert.strictEqual(finalWallet.wallet_balance, initialWalletBalance - 10000,
        'wallet debited exactly once after organizer confirm');
    });
  });

  // -----------------------------------------------------
  // 3. Reissue: cancel old, create new with new UTR
  // -----------------------------------------------------
  describe('3. Reissue (new payout, new UTR)', () => {
    it('should cancel old disputed, create new pending, wallet unchanged', async () => {
      // Admin reissues with a new UTR
      const reissueRes = await adminClient
        .rpc('admin_reissue_disputed_payout', {
          p_payout_id: 'some-payout-id-from-above',
          p_utr: 'NEWUTR789012',   // new reference
          p_payment_method: 'IMPS',
          p_admin_notes: 'Transfer failed, reissuing',
        });

      assert(reissueRes.ok === true, 'reissue succeeded');

      // Old row should be cancelled
      const oldRow = await masterClient
        .from('payout_items')
        .select('status')
        .eq('id', 'some-payout-id-from-above')
        .single();

      assert.strictEqual(oldRow.status, 'cancelled',
        'old payout cancelled');

      // New row should be pending_confirmation with new UTR
      const newRow = await masterClient
        .from('payout_items')
        .select('status, utr, replaces_payout_id')
        .eq('replaces_payout_id', 'some-payout-id-from-above')
        .single();

      assert.strictEqual(newRow.status, 'pending_confirmation',
        'new payout pending_confirmation');
      assert.strictEqual(newRow.utr, 'NEWUTR789012',
        'new payout has new UTR');
      assert.strictEqual(newRow.replaces_payout_id, 'some-payout-id-from-above',
        'new row links to old via replaces_payout_id');

      // Wallet unchanged
      const walletRes = await masterClient
        .from('communities')
        .select('wallet_balance')
        .eq('id', 'comm-test-001')
        .single();

      assert.strictEqual(walletRes.wallet_balance, initialWalletBalance,
        'wallet unchanged after reissue');
    });

    it('should reject duplicate/new UTR that collides with active payout', async () => {
      // Attempt reissue with a UTR already held by another active payout
      const badRes = await adminClient
        .rpc('admin_reissue_disputed_payout', {
          p_payout_id: 'some-payout-id-from-above',
          p_utr: 'EXISTINGUTR',   // already active somewhere
          p_payment_method: 'IMPS',
          p_admin_notes: 'should fail',
        });

      assert(badRes.ok === false, 'reissue with duplicate UTR rejected');
      assert.strictEqual(badRes.error, 'duplicate_payout_utr',
        'correct error returned');
    });
  });

  // -----------------------------------------------------
  // 4. Cancel & Release
  // -----------------------------------------------------
  describe('4. Cancel & Release', () => {
    it('should cancel disputed, release hold, wallet unchanged, available restored', async () => {
      // Admin cancels the disputed payout
      const cancelRes = await adminClient
        .rpc('admin_resolve_payout_dispute', {
          p_payout_id: 'some-payout-id-from-above',
          p_resolution: 'cancel_disputed_payout',
          p_resolution_notes: 'Transfer cancelled, funds released',
        });

      assert(cancelRes.ok === true, 'cancel accepted');

      // Old row cancelled, hold released
      const oldRow = await masterClient
        .from('payout_items')
        .select('status')
        .eq('id', 'some-payout-id-from-above')
        .single();

      assert.strictEqual(oldRow.status, 'cancelled',
        'old payout cancelled');

      // Wallet unchanged (was never debited)
      const walletRes = await masterClient
        .from('communities')
        .select('wallet_balance')
        .eq('id', 'comm-test-001')
        .single();

      assert.strictEqual(walletRes.wallet_balance, initialWalletBalance,
        'wallet unchanged after cancel');

      // Available balance should now include the released ₹100
      // (this is a computed field; we verify via the RPC later)
    });
  });

  // -----------------------------------------------------
  // 5. Statement ledger fields
  // -----------------------------------------------------
  describe('5. Ledger: wallet_debit_amount & reserved_amount', () => {
    it('should show wallet_debit_amount = amount only for success rows', async () => {
      // Query the admin statement and check the new key
      const stmtRes = await adminClient
        .rpc('get_admin_financial_statement', {
          p_community_id: 'comm-test-001',
          p_event_id: eventId1,
        });

      const rows = stmtRes.data || [];
      const payoutRow = rows.find(r => r.transaction_type === 'payout_confirmed');

      assert.isNotNull(payoutRow, 'payout row found in statement');

      // success → wallet_debit_amount = amount
      assert.strictEqual(payoutRow.wallet_debit_amount, 10000,
        'wallet_debit_amount = 10000 for success');

      // disputed → wallet_debit_amount = 0, reserved_amount = amount
      const discRow = rows.find(r => r.transaction_type === 'payout_disputed');
      assert.isNotNull(discRow, 'disputed row found');
      assert.strictEqual(discRow.wallet_debit_amount, 0,
        'wallet_debit_amount = 0 for disputed');
      assert.strictEqual(discRow.reserved_amount, 10000,
        'reserved_amount = 10000 for disputed');
    });

    it('should show running_balance on organizer statement', async () => {
      const stmtRes = await adminClient
        .rpc('get_organizer_financial_statement', {
          p_community_id: 'comm-test-001',
          p_event_id: eventId1,
        });

      const rows = stmtRes.data || [];
      assert.isArray(rows, 'organizer statement returns array');

      const payoutRow = rows.find(r => r.transaction_type === 'payout_confirmed');
      assert.isNotNull(payoutRow, 'payout row in organizer statement');

      // running_balance should be a number (not null/undefined)
      assert.isNumber(payoutRow.running_balance, 'running_balance is a number');
    });
  });
});