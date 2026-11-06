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

// Regression guard: every edge function invoked from a web app must allow the
// `apikey` header. The admin/organizer clients send it (supabase-js and
// supabase-fetch both do), and a preflight that omits it makes the browser
// block the real POST — the exact failure that broke admin-undelete-user.
Deno.test("every edge function called by a web app allows the apikey header", async () => {
  const functionsDir = new URL("../functions/", import.meta.url)
  const appSrcDirs = [
    new URL("../../apps/admin-web/src/", import.meta.url),
    new URL("../../apps/organizer-web/src/", import.meta.url),
  ]

  const referenced = new Set<string>()
  async function scan(dir: URL): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        await scan(new URL(`${entry.name}/`, dir))
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.includes(".test.")) continue
      const src = await Deno.readTextFile(new URL(entry.name, dir))
      for (const match of src.matchAll(/\/functions\/v1\/([a-z0-9-]+)/g)) {
        referenced.add(match[1])
      }
    }
  }
  for (const dir of appSrcDirs) await scan(dir)

  assert(referenced.size > 0, "expected to find edge-function references in web apps")

  const problems: string[] = []
  for (const name of referenced) {
    let src: string
    try {
      src = await Deno.readTextFile(new URL(`${name}/index.ts`, functionsDir))
    } catch {
      continue // reference in a comment/test fixture, not a real function
    }
    if (src.includes("getCorsHeaders")) continue
    const declared = src.match(/"Access-Control-Allow-Headers"\s*:\s*"([^"]*)"/)?.[1] ?? ""
    if (!declared.includes("apikey")) problems.push(`${name} (allow: ${declared || "none"})`)
  }

  assertEquals(
    problems,
    [],
    `web-callable functions missing "apikey" in Access-Control-Allow-Headers: ${problems.join(", ")}`,
  )
})
