// Authorization-hardening invariants (F-2/F-3/F-4/F-6/F-8/D9/D11/D12).
// Run: deno test supabase/tests/authz_hardening.test.ts
//
// Static gate over the migration SQL. It proves the intended grant/policy
// shape is present in the file; applying it to a live database is verified by
// the disposable two-phase harness (UNVERIFIED-PENDING-DEPLOY until wired in).

import { assert, assertEquals } from "jsr:@std/assert"

const MIGRATION = new URL("../migrations/202610220010_authz_hardening.sql", import.meta.url)
const sql = await Deno.readTextFile(MIGRATION)

const SENSITIVE = [
  "wallet_balance",
  "cashfree_beneficiary_id",
  "commission_percent",
  "commission_on",
  "platform_fee_amount",
  "contact_email",
  "contact_phone",
]

Deno.test("anon loses table-wide SELECT then gets a column whitelist", () => {
  assert(sql.includes("REVOKE SELECT ON public.communities FROM anon, PUBLIC;"))
  assert(sql.includes("GRANT SELECT (") && sql.includes("ON public.communities TO anon;"))
})

Deno.test("anon whitelist includes the fields public pages render", () => {
  const grant = sql.match(/GRANT SELECT \(([\s\S]*?)\) ON public\.communities TO anon;/)
  assert(grant, "anon column grant not found")
  const cols = grant[1].split(",").map((c) => c.trim())
  for (const col of ["id", "name", "owner_id", "member_count", "event_count", "visibility", "deleted_at"]) {
    assert(cols.includes(col), `expected ${col} in anon whitelist`)
  }
})

Deno.test("sensitive financial/contact columns are excluded from the anon whitelist", () => {
  const grant = sql.match(/GRANT SELECT \(([\s\S]*?)\) ON public\.communities TO anon;/)
  assert(grant, "anon column grant not found")
  const cols = grant[1].split(",").map((c) => c.trim())
  for (const col of SENSITIVE) {
    assert(!cols.includes(col), `${col} must not be granted to anon`)
  }
})

Deno.test("authenticated table-wide SELECT is superseded by the E-01 fix", async () => {
  // 202610220010 granted `authenticated` the whole table so select("*") kept
  // working. That is exactly the exposure E-01 closes; this test now pins the
  // supersession rather than the insecure shape.
  const fix = await Deno.readTextFile(
    new URL("../migrations/202610270003_community_financial_column_grants.sql", import.meta.url),
  )
  assert(fix.includes("REVOKE SELECT ON public.communities FROM authenticated, PUBLIC;"))
  assert(/GRANT SELECT \([\s\S]*?\) ON public\.communities TO authenticated;/.test(fix))
})

Deno.test("F-3: waitlist team delete is dropped and reads require the team role", () => {
  assert(sql.includes('DROP POLICY IF EXISTS "waitlist_team_delete" ON public.waitlist_entries;'))
  assert(!sql.includes('CREATE POLICY "waitlist_team_delete"'))
  const read = sql.match(/CREATE POLICY "waitlist_team_read"[\s\S]*?;/)
  assert(read, "waitlist_team_read policy not found")
  assert(read[0].includes("is_community_team"))
})

Deno.test("F-4: media team reads require the team role on both branches", () => {
  const policy = sql.match(/CREATE POLICY "media_team_read"[\s\S]*?;/)
  assert(policy, "media_team_read policy not found")
  const hits = policy[0].split("is_community_team").length - 1
  assertEquals(hits, 2)
})

Deno.test("F-6: public reviews require a visible public community", () => {
  const policy = sql.match(/CREATE POLICY "reviews_public_read"[\s\S]*?;/)
  assert(policy, "reviews_public_read policy not found")
  assert(policy[0].includes("c.visibility = 'public'"))
  assert(policy[0].includes("NOT c.is_hidden"))
})

Deno.test("F-8/D9/D11/D12: search_path, purge, guard, and legacy table", () => {
  const f8 = sql.slice(sql.indexOf("F-8:"), sql.indexOf("D11:"))
  const searchPathHits = f8.split("SET search_path = ''").length - 1
  assert(searchPathHits >= 2, "both SECURITY DEFINER functions need search_path")

  assert(sql.includes("TRUNCATE TABLE public.rate_limits;"))
  assert(sql.includes("idx_rate_limits_window_start"))

  const guard = sql.match(/CREATE OR REPLACE FUNCTION public\.guard_communities_privileged_columns[\s\S]*?\$\$;/)
  assert(guard, "guard function not found")
  assert(guard[0].includes("NEW.deleted_at"))

  assert(sql.includes("DROP TABLE IF EXISTS public.reports CASCADE;"))
})
