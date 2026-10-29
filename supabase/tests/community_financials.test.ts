// Regression tests for the communities financial-column exposure (E-01).
// Run: deno test supabase/tests/community_financials.test.ts
//
// Static gate over the migration + client code. Live proof needs a database:
//   select wallet_balance from communities  -> permission denied (42501)
//   rpc get_community_financials(other)     -> zero rows

import { assert, assertEquals } from "jsr:@std/assert"
import { COMMUNITY_CLIENT_COLUMNS } from "../../packages/shared/src/constants.ts"

const MIGRATION = new URL(
  "../migrations/202610270003_community_financial_column_grants.sql",
  import.meta.url,
)
const MIGRATION_GRACE = new URL(
  "../migrations/202610280002_community_deletion_grace.sql",
  import.meta.url,
)
const MIGRATION_CLOSURE = new URL(
  "../migrations/202610280003_community_closure.sql",
  import.meta.url,
)
const sql = await Deno.readTextFile(MIGRATION)
const sqlGrace = await Deno.readTextFile(MIGRATION_GRACE)
const sqlClosure = await Deno.readTextFile(MIGRATION_CLOSURE)
const allSql = `${sql}\n${sqlGrace}\n${sqlClosure}`

const WITHHELD = [
  "wallet_balance",
  "cashfree_beneficiary_id",
  "razorpay_account_id",
  "razorpay_account_status",
  "platform_fee_amount",
]

const grantMatches = [...allSql.matchAll(/GRANT SELECT \(([\s\S]*?)\) ON public\.communities TO authenticated;/g)]
assert(grantMatches.length >= 1, "authenticated column grant not found")
const granted = grantMatches.flatMap((m) => m[1].split(",").map((c) => c.trim()).filter(Boolean))

Deno.test("authenticated grant matches the shared client column list exactly", () => {
  assertEquals([...granted].sort(), [...COMMUNITY_CLIENT_COLUMNS].sort())
})

Deno.test("no financial column is granted to authenticated", () => {
  for (const col of WITHHELD) {
    assert(!granted.includes(col), `${col} must not be granted to authenticated`)
  }
})

Deno.test("table-wide SELECT is removed from authenticated and PUBLIC", () => {
  assert(sql.includes("REVOKE SELECT ON public.communities FROM authenticated, PUBLIC;"))
  // A column revoke alone would be ineffective against a table-level grant;
  // the table-wide revoke must come first.
  assert(
    sql.indexOf("REVOKE SELECT ON public.communities") <
      sql.indexOf("GRANT SELECT ("),
    "revoke must precede the column grant",
  )
})

Deno.test("public-facing columns stay readable", () => {
  for (const col of [
    "name",
    "description",
    "visibility",
    "contact_email",
    "contact_phone",
    "commission_percent",
  ]) {
    assert(granted.includes(col), `${col} should remain readable`)
  }
})

const rpc = sql.match(
  /CREATE OR REPLACE FUNCTION public\.get_community_financials\(p_community_id uuid\)[\s\S]*?\$\$;/,
)
assert(rpc, "get_community_financials not found")

Deno.test("financials RPC is definer, search_path-safe, and gated", () => {
  assert(rpc[0].includes("SECURITY DEFINER"))
  assert(rpc[0].includes("SET search_path = ''"))
  for (const gate of ["is_community_owner", "is_community_team", "is_admin_user"]) {
    assert(rpc[0].includes(`public.${gate}`), `${gate} must gate the RPC`)
  }
})

Deno.test("financials RPC is executable by authenticated only", () => {
  assert(
    sql.includes(
      "REVOKE ALL ON FUNCTION public.get_community_financials(uuid) FROM PUBLIC, anon;",
    ),
  )
  assert(
    sql.includes(
      "GRANT EXECUTE ON FUNCTION public.get_community_financials(uuid) TO authenticated, service_role;",
    ),
  )
})

Deno.test("financials RPC returns exactly the withheld columns", () => {
  const returns = rpc[0].match(/RETURNS TABLE \(([\s\S]*?)\)\s*LANGUAGE/)
  assert(returns, "RETURNS TABLE not found")
  const cols = returns[1].split(",").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
  assertEquals(cols.sort(), [...WITHHELD].sort())
})

Deno.test("no web client still selects every community column", async () => {
  const offenders: string[] = []
  async function walk(dir: URL) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir)
      if (entry.isDirectory) {
        await walk(child)
      } else if (/\.(ts|tsx|dart)$/.test(entry.name)) {
        const src = await Deno.readTextFile(child)
        if (/\.from\(["']communities["']\)\s*[\s\S]{0,40}?\.select\(\s*["'`]\*["'`]/.test(src)) {
          offenders.push(child.pathname.replace(/.*\/apps\//, "apps/"))
        }
      }
    }
  }
  await walk(new URL("../../apps/", import.meta.url))
  assertEquals(offenders, [])
})

Deno.test("payout page reads the balance through the RPC", async () => {
  const payout = await Deno.readTextFile(
    new URL(
      "../../apps/organizer-web/src/components/payout/payout-section.tsx",
      import.meta.url,
    ),
  )
  assert(payout.includes('supabase.rpc("get_community_financials"'))
  assert(!payout.includes('select("wallet_balance")'))
})
