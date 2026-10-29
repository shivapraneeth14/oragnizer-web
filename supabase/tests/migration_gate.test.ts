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
  ])
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

