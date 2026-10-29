import { assert, assertEquals } from "jsr:@std/assert"
import { getCorsHeaders, isOriginAllowed, DEFAULT_ALLOWED_ORIGINS } from "../functions/_shared/cors.ts"

Deno.test("isOriginAllowed recognizes exact matches in default allowlist", () => {
  assert(isOriginAllowed("https://cluvo.app", DEFAULT_ALLOWED_ORIGINS))
  assert(isOriginAllowed("https://org.cluvo.app", DEFAULT_ALLOWED_ORIGINS))
  assert(isOriginAllowed("https://admin.cluvo.app", DEFAULT_ALLOWED_ORIGINS))
  assert(isOriginAllowed("http://localhost:5173", DEFAULT_ALLOWED_ORIGINS))
  assert(isOriginAllowed("http://localhost:3000", DEFAULT_ALLOWED_ORIGINS))
})

Deno.test("isOriginAllowed rejects untrusted origins", () => {
  assert(!isOriginAllowed("https://malicious-site.com", DEFAULT_ALLOWED_ORIGINS))
  assert(!isOriginAllowed("https://cluvo.app.evil.com", DEFAULT_ALLOWED_ORIGINS))
  assert(!isOriginAllowed("http://localhost:9999", DEFAULT_ALLOWED_ORIGINS))
})

Deno.test("isOriginAllowed supports wildcard domain patterns", () => {
  const allowlist = ["*.cluvo.app"]
  assert(isOriginAllowed("https://preview.cluvo.app", allowlist))
  assert(isOriginAllowed("https://sub.preview.cluvo.app", allowlist))
  assert(!isOriginAllowed("https://notcluvo.app", allowlist))
})

Deno.test("getCorsHeaders echoes matching origin for trusted origin", () => {
  const req = new Request("https://api.example.com", {
    headers: { origin: "https://admin.cluvo.app" },
  })
  const headers = getCorsHeaders(req)
  assertEquals(headers["Access-Control-Allow-Origin"], "https://admin.cluvo.app")
})

Deno.test("getCorsHeaders echoes localhost dev origin for local testing", () => {
  const req = new Request("https://api.example.com", {
    headers: { origin: "http://localhost:5173" },
  })
  const headers = getCorsHeaders(req)
  assertEquals(headers["Access-Control-Allow-Origin"], "http://localhost:5173")
})

Deno.test("getCorsHeaders blocks untrusted origin by falling back to primary domain", () => {
  const req = new Request("https://api.example.com", {
    headers: { origin: "https://evil-attacker.com" },
  })
  const headers = getCorsHeaders(req)
  assertEquals(headers["Access-Control-Allow-Origin"], "https://cluvo.app")
})

Deno.test("getCorsHeaders returns wildcard when no origin header is present", () => {
  const req = new Request("https://api.example.com")
  const headers = getCorsHeaders(req)
  assertEquals(headers["Access-Control-Allow-Origin"], "*")
})
