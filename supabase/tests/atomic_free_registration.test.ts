// supabase/tests/atomic_free_registration.test.ts
// Verifies BUG-005 remediation:
// 1. Migration 202611010011 implements atomic register_free_event.
// 2. Lock hierarchy Level 1 (events FOR UPDATE) and Level 2 (registrations FOR UPDATE).
// 3. Captures v_reg_exists explicitly before subsequent SQL statements.
// 4. Idempotency guard prevents double-counting on retries.
// 5. Active checkout holds are included in capacity check.
// 6. Privilege isolation: revoked from anon/authenticated, granted only to service_role.
// 7. Edge function register-for-event delegates to register_free_event.

import { assert, assertEquals } from "jsr:@std/assert"

const migrationsDir = new URL("../migrations/", import.meta.url)
const functionsDir = new URL("../functions/register-for-event/", import.meta.url)

Deno.test("BUG-005: Migration 202611010011 enforces atomic free event registration", async () => {
  const sql = await Deno.readTextFile(new URL("202611010011_atomic_free_event_registration.sql", migrationsDir))

  // Function signature and security properties
  assert(sql.includes("CREATE OR REPLACE FUNCTION public.register_free_event("))
  assert(sql.includes("p_event_id UUID"))
  assert(sql.includes("p_user_id UUID"))
  assert(sql.includes("RETURNS JSONB"))
  assert(sql.includes("SECURITY DEFINER"))
  assert(sql.includes("SET search_path = ''"))

  // Defensive lock timeout
  assert(sql.includes("SET LOCAL lock_timeout = '3s'"))

  // Authorization assertion
  assert(sql.includes("IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id AND NOT public.is_admin_user() THEN"))
})

Deno.test("BUG-005: Enforces lock hierarchy, dedicated v_reg_exists variable, and idempotency", async () => {
  const sql = await Deno.readTextFile(new URL("202611010011_atomic_free_event_registration.sql", migrationsDir))

  // Level 1 Lock on events
  assert(sql.includes("FROM public.events"))
  assert(sql.includes("WHERE id = p_event_id"))
  assert(sql.includes("FOR UPDATE;"))

  // Level 2 Lock on registrations
  assert(sql.includes("FROM public.registrations"))
  assert(sql.includes("WHERE event_id = p_event_id AND user_id = p_user_id"))

  // Dedicated boolean storage of existing registration lookup
  assert(sql.includes("v_reg_exists := FOUND;"), "Must store FOUND immediately in v_reg_exists")

  // Idempotency: no double increment if already confirmed
  assert(sql.includes("IF v_reg_exists AND v_reg.status IN ('confirmed', 'attended') THEN"))
  assert(sql.includes("'already_registered', true"))
})

Deno.test("BUG-005: Capacity check synchronizes booked_count with active checkout holds", async () => {
  const sql = await Deno.readTextFile(new URL("202611010011_atomic_free_event_registration.sql", migrationsDir))

  // Must query unexpired pending holds excluding caller's own registration
  assert(sql.includes("status = 'pending'"))
  assert(sql.includes("hold_expires_at > clock_timestamp()"))
  assert(sql.includes("(NOT v_reg_exists OR id != v_reg.id)"))

  // Sum formula
  assert(sql.includes("(v_event.booked_count + v_active_holds + 1) > v_event.capacity"))
  assert(sql.includes("'capacity_full'"))
})

Deno.test("BUG-005: Strict privilege isolation to service_role", async () => {
  const sql = await Deno.readTextFile(new URL("202611010011_atomic_free_event_registration.sql", migrationsDir))

  assert(sql.includes("REVOKE ALL PRIVILEGES ON FUNCTION public.register_free_event(UUID, UUID) FROM PUBLIC, anon, authenticated;"))
  assert(sql.includes("GRANT EXECUTE ON FUNCTION public.register_free_event(UUID, UUID) TO service_role;"))
})

Deno.test("BUG-005: Edge function register-for-event delegates to atomic RPC", async () => {
  const ts = await Deno.readTextFile(new URL("index.ts", functionsDir))

  // Must invoke register_free_event RPC
  assert(ts.includes('supabase.rpc("register_free_event"'))
  assert(ts.includes("p_event_id: event_id"))
  assert(ts.includes("p_user_id: user.id"))

  // Must NOT perform raw non-atomic insert or separate increment
  assert(!ts.includes('from("registrations").insert'), "Must NOT perform raw client-side registration insert")
  assert(!ts.includes("increment_event_booked"), "Must NOT invoke separate increment_event_booked")
})
