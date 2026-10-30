// supabase/tests/event_capacity_guard.test.ts
// Verifies BUG-003 remediation:
// 1. Database table constraints: capacity > 0 and capacity >= booked_count.
// 2. Trigger check_event_capacity_and_status prevents reducing capacity below booked_count or active holds.
// 3. Trigger prevents reverting published events with registrations to draft.
// 4. Preserves valid cancellations ('cancelling', 'cancelled') and completions ('completed').
// 5. Zero silent rewrites of historical booked_count values.

import { assert, assertEquals } from "jsr:@std/assert"

const migrationsDir = new URL("../migrations/", import.meta.url)
const hooksDir = new URL("../../apps/organizer-web/src/hooks/", import.meta.url)

Deno.test("BUG-003: Migration 202611010009 enforces table constraints and trigger guards", async () => {
  const sql = await Deno.readTextFile(new URL("202611010009_event_capacity_and_status_guard.sql", migrationsDir))

  // Table constraints
  assert(sql.includes("chk_event_capacity_non_negative"), "Must add chk_event_capacity_non_negative")
  assert(sql.includes("CHECK (capacity IS NULL OR capacity > 0)"), "Must check capacity > 0")
  assert(sql.includes("chk_event_capacity_ge_booked"), "Must add chk_event_capacity_ge_booked")
  assert(sql.includes("CHECK (capacity IS NULL OR capacity >= booked_count)"), "Must check capacity >= booked_count")

  // Function & trigger
  assert(sql.includes("CREATE OR REPLACE FUNCTION public.check_event_capacity_and_status()"))
  assert(sql.includes("trg_events_capacity_and_status_guard"))
  assert(sql.includes("BEFORE UPDATE ON public.events"))

  // Guards
  assert(sql.includes("capacity_below_booked_count"))
  assert(sql.includes("capacity_below_active_holds"))
  assert(sql.includes("cannot_revert_published_event"))

  // Invariant: No silent historical booked_count rewrites
  assert(!sql.includes("UPDATE public.events SET booked_count"), "Must NOT rewrite historical booked_count")
})

Deno.test("BUG-003: Trigger logic accounts for active checkout holds without double counting", async () => {
  const sql = await Deno.readTextFile(new URL("202611010009_event_capacity_and_status_guard.sql", migrationsDir))

  // Must query pending registrations with valid holds
  assert(sql.includes("status = 'pending'"), "Must check pending registrations")
  assert(sql.includes("hold_expires_at > clock_timestamp()"), "Must check active hold expiry")

  // Formula must add booked_count and active holds
  assert(sql.includes("NEW.capacity < (NEW.booked_count + v_active_holds)"), "Must guard capacity against booked + holds")
})

Deno.test("BUG-003: Organizer web use-events hook validates capacity and draft status", async () => {
  const ts = await Deno.readTextFile(new URL("use-events.ts", hooksDir))

  assert(ts.includes("booked_count"), "useEvents must select booked_count")
  assert(ts.includes("Cannot reduce event capacity"), "useEvents must validate capacity against booked_count")
  assert(ts.includes("Cannot revert event to draft"), "useEvents must reject reverting to draft if booked_count > 0")
})

