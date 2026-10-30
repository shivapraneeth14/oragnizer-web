// supabase/tests/decommission_cashfree.test.ts
// Verifies BUG-002 remediation:
// 1. Obsolete Cashfree & direct booking functions removed from functions directory.
// 2. create-beneficiary decoupled from Cashfree API.
// 3. payout-status-sync unscheduled in migration 202611010008.

import { assert, assertEquals } from "jsr:@std/assert"

const functionsDir = new URL("../functions/", import.meta.url)
const migrationsDir = new URL("../migrations/", import.meta.url)

Deno.test("BUG-002: Five obsolete function directories are deleted locally", async () => {
  const obsolete = [
    "withdraw-wallet",
    "cashfree-webhook",
    "sync-payout-status",
    "create-booking",
    "create-payment-order",
  ]

  for (const name of obsolete) {
    let exists = false
    try {
      await Deno.stat(new URL(name, functionsDir))
      exists = true
    } catch (_) {
      exists = false
    }
    assertEquals(exists, false, `Function ${name} should be deleted locally`)
  }
})

Deno.test("BUG-002: create-beneficiary is decoupled from Cashfree API", async () => {
  const content = await Deno.readTextFile(new URL("create-beneficiary/index.ts", functionsDir))
  assert(!content.includes("cashfreePost"), "create-beneficiary must not call cashfreePost")
  assert(!content.includes("_shared/cashfree.ts"), "create-beneficiary must not import cashfree.ts")
  assert(content.includes("community_beneficiaries"), "Must insert into community_beneficiaries")
  assert(content.includes("bank_account_holder"), "Must validate bank_account_holder")
  assert(content.includes("bank_ifsc"), "Must validate IFSC")
})

Deno.test("BUG-002: Migration 202611010008 unschedules payout-status-sync", async () => {
  const content = await Deno.readTextFile(new URL("202611010008_decommission_cashfree_cron.sql", migrationsDir))
  assert(content.includes("payout-status-sync"), "Migration must target payout-status-sync")
  assert(content.includes("cron.unschedule"), "Migration must call cron.unschedule")
})

