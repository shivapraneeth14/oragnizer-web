import { assertEquals } from "jsr:@std/assert@1"
import {
  decideNextStep,
  isValidEmail,
  normalizeEmail,
} from "./account-step.ts"

Deno.test("normalizeEmail trims and lowercases", () => {
  assertEquals(normalizeEmail("  John.Doe@Example.COM  "), "john.doe@example.com")
  assertEquals(normalizeEmail("no-changes@x.io"), "no-changes@x.io")
})

Deno.test("normalizeEmail does NOT merge Gmail dot/plus variants", () => {
  // Documented decision: we do not strip dots or plus tags, so these stay
  // distinct addresses (and could become separate accounts).
  assertEquals(normalizeEmail("a.b+tag@gmail.com"), "a.b+tag@gmail.com")
  assertEquals(normalizeEmail("ab@gmail.com"), "ab@gmail.com")
})

Deno.test("isValidEmail accepts sane addresses", () => {
  assertEquals(isValidEmail("you@example.com"), true)
  assertEquals(isValidEmail("a@b.co"), true)
  assertEquals(isValidEmail("first.last+tag@sub.example.co.uk"), true)
})

Deno.test("isValidEmail rejects malformed addresses", () => {
  assertEquals(isValidEmail(""), false)
  assertEquals(isValidEmail("plain"), false)
  assertEquals(isValidEmail("no@domain"), false)
  assertEquals(isValidEmail("@example.com"), false)
  assertEquals(isValidEmail("a b@example.com"), false)
  assertEquals(isValidEmail(`${"a".repeat(250)}@example.com`), false)
})

Deno.test("decideNextStep: unknown email -> signup", () => {
  assertEquals(decideNextStep({ userExists: false, hasPassword: false }), "signup")
})

Deno.test("decideNextStep: known account with a password -> password", () => {
  assertEquals(decideNextStep({ userExists: true, hasPassword: true }), "password")
})

Deno.test("decideNextStep: known account without a password -> google", () => {
  assertEquals(decideNextStep({ userExists: true, hasPassword: false }), "google")
})

Deno.test("decideNextStep: unknown email never leaks hasPassword", () => {
  // Even if a stale hasPassword flag arrives true, a missing user is signup.
  assertEquals(decideNextStep({ userExists: false, hasPassword: true }), "signup")
})
