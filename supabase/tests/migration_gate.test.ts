// Migration gate for the deletion/grace-support migrations.
// Run: deno test supabase/tests/migration_gate.test.ts
//
// Static invariants over the SQL. The disposable two-phase database run
// (apply pre-hardening schema, seed fixtures, apply new migrations, assert
// data survives) is UNVERIFIED-PENDING-DEPLOY until `supabase start` is
// available in CI.

import { assert, assertEquals } from "jsr:@std/assert"

const dir = new URL("../migrations/", import.meta.url)

async function read(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, dir))
}

const grace = await read("202610220011_grace_period_support.sql")
const payment = await read("202610220012_payment_null_tolerance.sql")
const audit = await read("202610220013_payment_audit_scrub_support.sql")
const outbox = await read("202610220014_media_cleanup_outbox.sql")
const purgeCron = await read("202610220015_schedule_deletion_purge.sql")
const reportsRetention = await read("202610220016_content_reports_retain_on_delete.sql")
const refundStatus = await read("202610290003_confirm_payment_refund_status.sql")
const atomicCheckIn = await read("202610300002_atomic_check_in.sql")
const adminFinancials = await read("202610300003_admin_financial_ledger_and_payouts.sql")
const adminCommunities = await read("202610300004_admin_communities_dropdown.sql")
const adminProfilesAndLedgerFix = await read("202610300005_admin_profiles_rpc_and_fix_ledger.sql")
const organizerFinancialsAndDispute = await read("202610300006_organizer_financial_statement_and_dispute.sql")
const communityApplicationsAndApproval = await read("202610300007_community_applications_and_approval_flow.sql")

Deno.test("migration version prefixes are unique and ordered", async () => {
  const names = (await Array.fromAsync(Deno.readDir(dir)))
    .map((e) => e.name)
    .filter((n) => n.endsWith(".sql"))
    .sort()
  assertEquals(new Set(names).size, names.length)

  // The deploy CLI keys history by the numeric prefix, not the full filename.
  // Duplicate prefixes (e.g. two 202610210001_* files) make `supabase db push`
  // refuse with "Rerun with --include-all". Assert prefixes are unique.
  const versions = names.map((n) => n.split("_")[0])
  const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i)
  assertEquals(duplicates, [], `duplicate migration versions: ${duplicates.join(", ")}`)

  const ours = names.filter((n) => n >= "202610220010")
  assertEquals(ours, [
    "202610220010_authz_hardening.sql",
    "202610220011_grace_period_support.sql",
    "202610220012_payment_null_tolerance.sql",
    "202610220013_payment_audit_scrub_support.sql",
    "202610220014_media_cleanup_outbox.sql",
    "202610220015_schedule_deletion_purge.sql",
    "202610220016_content_reports_retain_on_delete.sql",
    "202610270001_profile_guard_deletion_columns.sql",
    "202610270002_revoke_user_sessions.sql",
    "202610270003_community_financial_column_grants.sql",
    "202610270004_retire_private_communities.sql",
    "202610280001_fix_cancelled_event_cleanup.sql",
    "202610280002_community_deletion_grace.sql",
    "202610280003_community_closure.sql",
    "202610280004_block_activity_on_closure_grace.sql",
    "202610290001_block_members_of_closure_communities.sql",
    "202610290002_revoke_on_admin_demotion.sql",
    "202610290003_confirm_payment_refund_status.sql",
    "202610290004_fix_community_closure_rls_recursion.sql",
    "202610290005_deploy_community_financials_rpc.sql",
    "202610290006_grant_community_grace_and_closure_columns.sql",
    "202610300001_reconcile_cron_2min.sql",
    "202610300002_atomic_check_in.sql",
    "202610300003_admin_financial_ledger_and_payouts.sql",
    "202610300004_admin_communities_dropdown.sql",
    "202610300005_admin_profiles_rpc_and_fix_ledger.sql",
    "202610300006_organizer_financial_statement_and_dispute.sql",
    "202610300007_community_applications_and_approval_flow.sql",
    "202610300008_harden_rls_policies.sql",
    "202610300009_payment_and_registration_index_optimizations.sql",
    "202610310001_cancellation_queue_engine.sql",
    "202610310002_schedule_cancellation_worker.sql",
    "202611010001_incoming_payment_remediation.sql",
    "202611010002_fix_webhook_processed_at.sql",
    "202611010003_manual_payout_deduplication.sql",
    "202611010004_fix_booking_hold_reuse.sql",
    "202611010005_fix_financial_statement_refund_debits.sql",
    "202611010006_financial_reconciliation_engine.sql",
  ])
})

Deno.test("202611010002 fix_webhook_processed_at fixes column name to processed_at", async () => {
  const fix1 = await read("202611010002_fix_webhook_processed_at.sql")
  assert(fix1.includes("processed_webhooks (id, provider, event_type, processed_at)"))
  assert(!fix1.includes("processed_webhooks (id, provider, event_type, created_at)"))
  assert(fix1.includes("CREATE OR REPLACE FUNCTION public.confirm_payment_from_webhook"))
  assert(fix1.includes("REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment_from_webhook"))
})

Deno.test("202611010003 manual_payout_deduplication creates scoped partial unique index and RPC duplicate check", async () => {
  const fix2 = await read("202611010003_manual_payout_deduplication.sql")
  assert(fix2.includes("uq_payout_items_active_transfer"))
  assert(fix2.includes("UPPER(TRIM(utr))"))
  assert(fix2.includes("WHERE status IN ('pending_confirmation', 'success')"))
  assert(fix2.includes("duplicate_payout_utr"))
  assert(fix2.includes("CREATE OR REPLACE FUNCTION public.admin_record_manual_payout"))
})

Deno.test("202611010004 fix_booking_hold_reuse hoists hold reuse check outside payments lookup", async () => {
  const fix3 = await read("202611010004_fix_booking_hold_reuse.sql")
  assert(fix3.includes("CREATE OR REPLACE FUNCTION public.reserve_ticket_capacity"))
  assert(fix3.includes("'reused_hold', true"))
  assert(fix3.includes("v_reg.status = 'pending' AND v_reg.hold_expires_at > clock_timestamp()"))
})

Deno.test("202611010001 incoming_payment_remediation defines capacity holds, atomic webhook confirmation, and unique index", async () => {
  const rem = await read("202611010001_incoming_payment_remediation.sql")
  assert(rem.includes("ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ DEFAULT NULL"))
  assert(rem.includes("idx_registrations_active_holds"))
  assert(rem.includes("uq_payments_razorpay_payment_id"))
  assert(rem.includes("CREATE OR REPLACE FUNCTION public.reserve_ticket_capacity"))
  assert(rem.includes("CREATE OR REPLACE FUNCTION public.release_ticket_capacity"))
  assert(rem.includes("CREATE OR REPLACE FUNCTION public.confirm_payment"))
  assert(rem.includes("CREATE OR REPLACE FUNCTION public.confirm_payment_from_webhook"))
  assert(rem.includes("public.registrations.status NOT IN ('confirmed', 'attended')"))
  assert(rem.includes("REVOKE ALL PRIVILEGES ON FUNCTION public.reserve_ticket_capacity"))
})

Deno.test("011 adds both grace columns, the index, and the grant", () => {
  assert(grace.includes("ADD COLUMN IF NOT EXISTS deletion_grace_started_at timestamptz"))
  assert(grace.includes("ADD COLUMN IF NOT EXISTS deletion_purging_at timestamptz"))
  assert(grace.includes("idx_profiles_deletion_grace"))
  assert(grace.includes("GRANT SELECT (deletion_grace_started_at) ON public.profiles TO authenticated;"))
})

Deno.test("claim_due_deletions is locked, search_path-safe, and service_role only", () => {
  assert(grace.includes("FOR UPDATE SKIP LOCKED"))
  assert(grace.includes("SET search_path = ''"))
  assert(grace.includes("REVOKE ALL ON FUNCTION public.claim_due_deletions(int) FROM PUBLIC, anon, authenticated;"))
  assert(grace.includes("GRANT EXECUTE ON FUNCTION public.claim_due_deletions(int) TO service_role;"))
  assert(grace.includes("deletion_grace_started_at <= now() - interval '30 days'"))
})

Deno.test("012 confirm_payment keeps both the cancelled-registration and NULL-user guards", () => {
  assert(payment.includes("CREATE OR REPLACE FUNCTION confirm_payment"))
  // 012 redefines confirm_payment after 005, so it must carry 005's guard.
  assert(payment.includes("v_payment.reg_status = 'cancelled'"))
  assert(payment.includes("failure_reason = 'registration_cancelled'"))
  assert(payment.includes("IF v_payment.user_id IS NOT NULL THEN"))
  assert(payment.includes("INSERT INTO public.notifications"))
})

Deno.test("013 adds the JSONB scrub index and payment lookup index", () => {
  assert(audit.includes("idx_payment_audit_log_details"))
  assert(audit.includes("USING gin (details)"))
  assert(audit.includes("idx_payment_audit_log_payment_id"))
})

Deno.test("015 schedules the purge via Vault, never a hardcoded URL", () => {
  assert(purgeCron.includes("cron.schedule("))
  assert(purgeCron.includes("purge-deleted-accounts"))
  assert(purgeCron.includes("vault.decrypted_secrets"))
  assert(purgeCron.includes("x-purge-secret"))
  assert(!purgeCron.includes("supabase.co/functions"))
  assert(!purgeCron.includes("ofvfasdgdwkehdcjugnf"))
  assert(!purgeCron.includes("vdxspyumkvwawmqwfkzr"))
})

Deno.test("016 retains reports and unlinks the reporter", () => {
  assert(reportsRetention.includes("ALTER COLUMN reporter_id DROP NOT NULL"))
  assert(reportsRetention.includes("ON DELETE SET NULL"))
  assert(reportsRetention.includes("content_reports_reporter_id_fkey"))
})

Deno.test("014 outbox is deny-all for clients and service_role-writable", () => {
  assert(outbox.includes("CREATE TABLE IF NOT EXISTS public.media_cleanup_jobs"))
  for (const col of ["public_id", "provider", "status", "attempts", "next_attempt_at", "last_error_class"]) {
    assert(outbox.includes(col), `missing outbox column ${col}`)
  }
  assert(outbox.includes("ENABLE ROW LEVEL SECURITY"))
  assert(outbox.includes("REVOKE ALL ON public.media_cleanup_jobs FROM anon, authenticated;"))
  assert(outbox.includes("GRANT ALL ON public.media_cleanup_jobs TO service_role;"))
  assert(outbox.includes("idx_media_cleanup_pending"))
  assert(outbox.includes("FOR EACH ROW EXECUTE FUNCTION public.set_media_cleanup_updated_at()"))
})

Deno.test("202610290003 confirm_payment sets refund_reason without blocking refund_status", () => {
  assert(refundStatus.includes("CREATE OR REPLACE FUNCTION confirm_payment"))
  assert(!refundStatus.includes("refund_status = COALESCE(refund_status, 'requested')"))
  assert(refundStatus.includes("refund_reason = COALESCE(refund_reason, 'registration_cancellation')"))
  assert(refundStatus.includes("refund_reason = COALESCE(refund_reason, 'event_cancellation')"))
  assert(refundStatus.includes("refund_reason = COALESCE(refund_reason, 'capacity_full')"))
})

Deno.test("202610300002 check_in_registration has row lock, atomic conditional update, and service_role grant", () => {
  assert(atomicCheckIn.includes("FOR UPDATE OF r"))
  assert(atomicCheckIn.includes("SET search_path = ''"))
  assert(atomicCheckIn.includes("WHERE id = v_reg.id\n    AND checked_in = FALSE"))
  assert(atomicCheckIn.includes("RETURNING id INTO v_updated_id"))
  assert(atomicCheckIn.includes("REVOKE ALL PRIVILEGES ON FUNCTION public.check_in_registration(text) FROM PUBLIC, anon, authenticated;"))
  assert(atomicCheckIn.includes("GRANT EXECUTE ON FUNCTION public.check_in_registration(text) TO service_role;"))
})

Deno.test("202610300003 admin_financial_ledger_and_payouts deploys passbook RPC and manual payout RPCs", () => {
  assert(adminFinancials.includes("CREATE OR REPLACE FUNCTION public.get_admin_financial_statement"))
  assert(adminFinancials.includes("public.is_admin_user()"))
  assert(adminFinancials.includes("ORDER BY w.created_at DESC"))
  assert(adminFinancials.includes("CREATE OR REPLACE FUNCTION public.admin_record_manual_payout"))
  assert(adminFinancials.includes("CREATE OR REPLACE FUNCTION public.organizer_confirm_manual_payout"))
  assert(adminFinancials.includes("wallet_balance = wallet_balance - v_payout.amount"))
})

Deno.test("202610300004 admin_communities_dropdown deploys get_admin_communities RPC", () => {
  assert(adminCommunities.includes("CREATE OR REPLACE FUNCTION public.get_admin_communities"))
  assert(adminCommunities.includes("public.is_admin_user()"))
  assert(adminCommunities.includes("GRANT EXECUTE ON FUNCTION public.get_admin_communities() TO authenticated, service_role;"))
})

Deno.test("202610300005 admin_profiles_rpc_and_fix_ledger fixes attendee_phone and deploys get_admin_profiles RPC", () => {
  assert(adminProfilesAndLedgerFix.includes("CREATE OR REPLACE FUNCTION public.get_admin_financial_statement"))
  assert(adminProfilesAndLedgerFix.includes("NULL::TEXT AS attendee_phone"))
  assert(!adminProfilesAndLedgerFix.includes("prof.phone"))
  assert(adminProfilesAndLedgerFix.includes("CREATE OR REPLACE FUNCTION public.get_admin_profiles"))
  assert(adminProfilesAndLedgerFix.includes("GRANT EXECUTE ON FUNCTION public.get_admin_profiles(BOOLEAN, BOOLEAN, BOOLEAN) TO authenticated, service_role;"))
})

Deno.test("202610300006 organizer_financial_statement_and_dispute deploys organizer RPCs", () => {
  assert(organizerFinancialsAndDispute.includes("CREATE OR REPLACE FUNCTION public.organizer_dispute_manual_payout"))
  assert(organizerFinancialsAndDispute.includes("status = 'disputed'"))
  assert(organizerFinancialsAndDispute.includes("CREATE OR REPLACE FUNCTION public.get_organizer_financial_statement"))
  assert(organizerFinancialsAndDispute.includes("public.is_community_owner(p_community_id) OR public.is_community_team(p_community_id)"))
})

Deno.test("202610300007 community_applications_and_approval_flow deploys staging table and approval RPCs", () => {
  assert(communityApplicationsAndApproval.includes("CREATE TABLE IF NOT EXISTS public.community_applications"))
  assert(communityApplicationsAndApproval.includes("CREATE OR REPLACE FUNCTION public.admin_approve_community_application"))
  assert(communityApplicationsAndApproval.includes("CREATE OR REPLACE FUNCTION public.admin_reject_community_application"))
  assert(communityApplicationsAndApproval.includes("CREATE OR REPLACE FUNCTION public.get_admin_community_applications"))
  assert(communityApplicationsAndApproval.includes("public.is_admin_user()"))
})

Deno.test("202610300009 payment_and_registration_index_optimizations adds safe non-concurrent indexes", async () => {
  const indexesMigration = await read("202610300009_payment_and_registration_index_optimizations.sql")
  assert(indexesMigration.includes("idx_payments_order_status"))
  assert(indexesMigration.includes("idx_payments_pending_reconcile"))
  assert(!indexesMigration.includes("INDEX CONCURRENTLY"), "Migration must NOT use CREATE INDEX CONCURRENTLY inside transactional runner")
})

Deno.test("202611010005 fix_financial_statement_refund_debits dedupes by provider refund id and enforces cumulative share cap", async () => {
  const fix5 = await read("202611010005_fix_financial_statement_refund_debits.sql")
  assert(fix5.includes("CREATE OR REPLACE FUNCTION public.get_admin_financial_statement"))
  assert(fix5.includes("CREATE OR REPLACE FUNCTION public.get_organizer_financial_statement"))
  assert(fix5.includes("SELECT DISTINCT ON (COALESCE(prh.razorpay_refund_id, prh.id::TEXT))"))
  assert(fix5.includes("ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING"))
  assert(fix5.includes("pal.action = 'wallet_debited'"))
  assert(fix5.includes("WHEN rt.transaction_type = 'refund' OR rt.status IN ('success', 'processed') THEN rt.money_out"))
})

Deno.test("202611010006 financial_reconciliation_engine provides strictly read-only 3-way reconciliation, KPIs, and concurrency-safe payout locking", async () => {
  const fix6 = await read("202611010006_financial_reconciliation_engine.sql")
  assert(fix6.includes("CREATE OR REPLACE FUNCTION public.run_financial_reconciliation"))
  assert(fix6.includes("CREATE OR REPLACE FUNCTION public.get_financial_observability_kpis"))
  assert(fix6.includes("CREATE OR REPLACE FUNCTION public.admin_record_manual_payout"))
  assert(fix6.includes("STABLE"))
  assert(fix6.includes("SECURITY DEFINER"))
  assert(fix6.includes("stored_wallet_balance"))
  assert(fix6.includes("audit_ledger_balance"))
  assert(fix6.includes("primary_transaction_balance"))
  assert(fix6.includes("in_flight_pending_payouts"))
  assert(fix6.includes("uncommitted_wallet_balance"))
  assert(fix6.includes("stored_vs_ledger_diff"))
  assert(fix6.includes("stored_vs_primary_diff"))
  assert(fix6.includes("FOR UPDATE"))
  assert(fix6.includes("insufficient_uncommitted_balance"))
  assert(fix6.includes("REVOKE ALL PRIVILEGES ON FUNCTION public.run_financial_reconciliation"))
  assert(fix6.includes("REVOKE ALL PRIVILEGES ON FUNCTION public.get_financial_observability_kpis"))
  assert(fix6.includes("REVOKE ALL PRIVILEGES ON FUNCTION public.admin_record_manual_payout"))
})





