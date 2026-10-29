// Static regression tests for server-side session revocation (E-04).
// Run: deno test supabase/tests/session_revocation.test.ts

import { assert, assertEquals } from "jsr:@std/assert"

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, import.meta.url))
}

const migration = await read("../migrations/202610270002_revoke_user_sessions.sql")
const demoteMigration = await read("../migrations/202610290002_revoke_on_admin_demotion.sql")
const adminDelete = await read("../functions/admin-delete-user/index.ts")
const deleteAccount = await read("../functions/delete-account/index.ts")
const config = await read("../config.toml")

const fn = migration.match(
  /CREATE OR REPLACE FUNCTION public\.admin_revoke_user_sessions\(p_user_id uuid\)[\s\S]*?\$\$;/,
)
assert(fn, "admin_revoke_user_sessions definition not found")

Deno.test("revoke RPC deletes GoTrue refresh tokens and sessions", () => {
  assert(fn[0].includes("DELETE FROM auth.refresh_tokens WHERE user_id = p_user_id::text"))
  assert(fn[0].includes("DELETE FROM auth.sessions WHERE user_id = p_user_id"))
})

Deno.test("revoke RPC is definer with an empty search_path", () => {
  assert(fn[0].includes("SECURITY DEFINER"))
  assert(fn[0].includes("SET search_path = ''"))
})

Deno.test("revoke RPC is callable by service_role only", () => {
  assert(fn[0].includes("request.jwt.claims"))
  assert(fn[0].includes("<> 'service_role'"))
  assert(
    migration.includes(
      "REVOKE ALL ON FUNCTION public.admin_revoke_user_sessions(uuid) FROM PUBLIC, anon, authenticated;",
    ),
  )
  assert(
    migration.includes(
      "GRANT EXECUTE ON FUNCTION public.admin_revoke_user_sessions(uuid) TO service_role;",
    ),
  )
})

Deno.test("admin-delete-user calls the RPC instead of the invalid signOut", () => {
  assert(adminDelete.includes('supabase.rpc("admin_revoke_user_sessions"'))
  assert(!adminDelete.includes("signOut(user_id"))
  assert(!adminDelete.includes("signOut(user.id"))
  assert(!adminDelete.includes('.auth.admin.signOut('))
})

Deno.test("both suspend and grace paths revoke sessions", () => {
  const calls = adminDelete.match(/await revokeSessions\(user_id\)/g) ?? []
  assertEquals(calls.length, 2, "expected revokeSessions in both branches")
})

Deno.test("suspend checks the ban result before mutating profile state", () => {
  const suspendStart = adminDelete.indexOf("// suspend mode (default, reversible).")
  assert(suspendStart > -1, "suspend branch not found")
  const suspend = adminDelete.slice(suspendStart)
  const banIdx = suspend.indexOf("ban_duration")
  const revokeIdx = suspend.indexOf("await revokeSessions(user_id)")
  const stateIdx = suspend.indexOf('.from("profiles")')
  assert(banIdx > -1 && revokeIdx > banIdx, "ban must run before session revoke")
  assert(revokeIdx < stateIdx, "sessions must be revoked before deleted_at is set")
  assert(adminDelete.includes("if (banErr) throw banErr"))
})

Deno.test("access-token lifetime is bounded to 15 minutes", () => {
  assert(/^jwt_expiry = 900$/m.test(config))
})

Deno.test("self-delete keeps using the caller's JWT for global sign-out", () => {
  assert(deleteAccount.includes('signOut(token, "global")'))
})

Deno.test("admin demotion trigger revokes sessions on is_admin = false", () => {
  const demoteFn = demoteMigration.match(
    /CREATE OR REPLACE FUNCTION public\.trg_revoke_demoted_admin_sessions\(\)[\s\S]*?\$\$;/,
  )
  assert(demoteFn, "trg_revoke_demoted_admin_sessions definition not found")
  assert(demoteFn[0].includes("SECURITY DEFINER"))
  assert(demoteFn[0].includes("SET search_path = ''"))
  assert(demoteFn[0].includes("DELETE FROM auth.refresh_tokens WHERE user_id = OLD.id::text"))
  assert(demoteFn[0].includes("DELETE FROM auth.sessions WHERE user_id = OLD.id"))

  assert(demoteMigration.includes("CREATE TRIGGER trg_demote_admin_revoke_sessions"))
  assert(demoteMigration.includes("AFTER UPDATE OF is_admin ON public.profiles"))
  assert(demoteMigration.includes("WHEN (OLD.is_admin = true AND NEW.is_admin = false)"))
  assert(demoteMigration.includes("EXECUTE FUNCTION public.trg_revoke_demoted_admin_sessions()"))
})
