// Static regression tests for retiring private communities (E-02 + product rule).
// Run: deno test supabase/tests/private_communities.test.ts
//
// Live proof needs a database:
//   anon select a published event of a private community -> 0 rows
//   the same event for a registered attendee             -> 1 row
//   insert a private community                           -> 23514

import { assert, assertEquals } from "jsr:@std/assert"

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, import.meta.url))
}

const migration = await read("../migrations/202610270004_retire_private_communities.sql")
const createFn = await read("../functions/create-community/index.ts")
const updateFn = await read("../functions/update-community-profile/index.ts")

const guard = migration.match(
  /CREATE OR REPLACE FUNCTION public\.enforce_public_communities\(\)[\s\S]*?\$\$;/,
)
assert(guard, "enforce_public_communities not found")

Deno.test("new private communities are rejected on insert", () => {
  assert(guard[0].includes("TG_OP = 'INSERT'"))
  assert(guard[0].includes("NEW.visibility IS DISTINCT FROM 'public'"))
  assert(guard[0].includes("ERRCODE = '23514'"))
})

Deno.test("public -> private updates are rejected, legacy private rows survive", () => {
  assert(guard[0].includes("TG_OP = 'UPDATE'"))
  assert(guard[0].includes("NEW.visibility IS DISTINCT FROM OLD.visibility"))
  // Only a non-public *target* is rejected; private -> private is a no-op on
  // visibility and must keep working for legacy rows.
  assert(
    /NEW\.visibility IS DISTINCT FROM OLD\.visibility\s+AND NEW\.visibility IS DISTINCT FROM 'public'/.test(
      guard[0],
    ),
  )
})

Deno.test("guard is search_path-safe and fires on insert and update", () => {
  assert(guard[0].includes("SET search_path = ''"))
  assert(
    /CREATE TRIGGER trg_communities_public_only\s+BEFORE INSERT OR UPDATE ON public\.communities/.test(
      migration,
    ),
  )
})

const policy = migration.match(/"events_public_read" ON public\.events[\s\S]*?\);/)
assert(policy, "events_public_read policy not found")

Deno.test("event public read requires a public, live, non-hidden community", () => {
  for (const predicate of [
    "c.visibility = 'public'",
    "c.deleted_at IS NULL",
    "c.is_hidden = false",
  ]) {
    assert(policy[0].includes(predicate), `missing ${predicate}`)
  }
  assert(policy[0].includes("status = 'published'"))
  assert(policy[0].includes("deleted_at IS NULL"))
})

Deno.test("create-community forces public regardless of input", () => {
  assert(createFn.includes('visibility: "public"'))
  assert(!createFn.includes("visibility: visibility"))
  assert(!createFn.includes("visibility ||"))
  assert(!createFn.includes("tags, visibility, rules"))
})

Deno.test("update-community-profile refuses private", () => {
  assert(updateFn.includes('visibility !== "public"'))
  assert(updateFn.includes("Private communities are not supported."))
  assert(!updateFn.includes('["public", "private"]'))
})

Deno.test("no client code sends visibility: private", async () => {
  const offenders: string[] = []
  async function walk(dir: URL) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir)
      if (entry.isDirectory) {
        await walk(child)
      } else if (/\.(ts|tsx|dart)$/.test(entry.name)) {
        const src = await Deno.readTextFile(child)
        if (/visibility\s*:\s*["']private["']/.test(src)) {
          offenders.push(child.pathname.replace(/.*\/apps\//, "apps/"))
        }
      }
    }
  }
  await walk(new URL("../../apps/", import.meta.url))
  assertEquals(offenders, [])
})
