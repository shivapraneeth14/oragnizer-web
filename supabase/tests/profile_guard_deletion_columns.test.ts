// Static regression tests for the profiles privileged-column guard (E-03).
// Run: deno test supabase/tests/profile_guard_deletion_columns.test.ts
//
// The guard is the only enforcement point: Supabase grants table-wide UPDATE
// to `authenticated`, so a column-level REVOKE is ignored (see 202610140002).
// These tests pin the SQL shape; live enforcement needs a real database.

import { assert } from "jsr:@std/assert"

const MIGRATION = new URL(
  "../migrations/202610270001_profile_guard_deletion_columns.sql",
  import.meta.url,
)
const sql = await Deno.readTextFile(MIGRATION)

const body = sql.match(
  /CREATE OR REPLACE FUNCTION public\.guard_profiles_privileged_columns\(\)[\s\S]*?\$\$;/,
)
assert(body, "guard_profiles_privileged_columns definition not found")
const fn = body[0]

const PROTECTED = [
  "is_admin",
  "email",
  "deleted_at",
  "deletion_grace_started_at",
  "deletion_purging_at",
]

Deno.test("guard rejects every account-state column from clients", () => {
  for (const col of PROTECTED) {
    assert(
      new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`).test(fn),
      `${col} must be guarded with IS DISTINCT FROM`,
    )
  }
})

Deno.test("guard is a NULL-safe no-op for unchanged values", () => {
  // IS DISTINCT FROM (not <>) is what lets a client echo an existing NULL
  // value without tripping the guard.
  assert(!/[^S]\sNEW\.deleted_at\s*<>\s*OLD\.deleted_at/.test(fn))
  assert(fn.includes("IS DISTINCT FROM"))
})

Deno.test("guard only applies to real client roles", () => {
  assert(fn.includes("IF current_user IN ('anon', 'authenticated')"))
  assert(fn.includes("ERRCODE = '42501'"))
})

Deno.test("guard keeps an empty search_path", () => {
  assert(fn.includes("SET search_path = ''"))
})

Deno.test("guard does not rely on an ineffective column-level REVOKE", () => {
  assert(!/REVOKE UPDATE \([\s\S]*?\) ON public\.profiles FROM/.test(sql))
})

Deno.test("trigger is recreated on profiles", () => {
  assert(sql.includes("DROP TRIGGER IF EXISTS trg_profiles_guard_privileged ON public.profiles"))
  assert(
    /CREATE TRIGGER trg_profiles_guard_privileged\s+BEFORE UPDATE ON public\.profiles\s+FOR EACH ROW EXECUTE FUNCTION public\.guard_profiles_privileged_columns\(\)/.test(
      sql,
    ),
  )
  assert(sql.includes("REVOKE ALL ON FUNCTION public.guard_profiles_privileged_columns() FROM PUBLIC, anon, authenticated"))
})

Deno.test("service-role writers are not blocked by the guard", () => {
  // Every privileged writer runs through an edge function with the service
  // role key; none of them may be rewritten to impersonate a client role.
  for (const path of [
    "../functions/delete-account/index.ts",
    "../functions/admin-delete-user/index.ts",
    "../functions/admin-undelete-user/index.ts",
    "../functions/purge-deleted-accounts/index.ts",
    "../functions/cancel-account-deletion/index.ts",
  ]) {
    const src = Deno.readTextFileSync(new URL(path, import.meta.url))
    assert(
      src.includes("SUPABASE_SERVICE_ROLE_KEY"),
      `${path} must write account state with the service role`,
    )
    assert(
      !src.includes("deletion_grace_started_at: null") ||
        src.includes("SUPABASE_SERVICE_ROLE_KEY"),
      `${path} must not clear grace as a client`,
    )
  }
})
