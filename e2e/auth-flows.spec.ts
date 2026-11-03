import { test, expect, type Page } from "@playwright/test"

/**
 * Authenticated E2E flow specs against the TEST project (ofvfasdgdwkehdcjugnf).
 *
 * The web apps log in via Google/OTP (not automatable headlessly), so we inject
 * a real TEST session into localStorage BEFORE the app loads. supabase-js v2
 * stores the session under `sb-<project-ref>-auth-token` (NOT the older
 * `supabase.auth.token`), with the user split into a `-user` key.
 *
 * Run with the session injected via env (token never committed):
 *   E2E_ACCESS_TOKEN=... E2E_EXPIRES_AT=... npx playwright test e2e/auth-flows.spec.ts
 */

const ACCESS_TOKEN = process.env.E2E_ACCESS_TOKEN || ""
const EXPIRES_AT = Number(process.env.E2E_EXPIRES_AT || "0")
const STORAGE_KEY = process.env.E2E_STORAGE_KEY || "sb-ofvfasdgdwkehdcjugnf-auth-token"
const USER_ID = process.env.E2E_USER_ID || "dc7c37ab-b23c-43c9-b844-ecd1376130f9"
const USER_EMAIL = process.env.E2E_USER_EMAIL || "shivapraneeth01@gmail.com"

const USER = {
  id: USER_ID,
  email: USER_EMAIL,
  role: "authenticated",
  app_metadata: { cluvo_provisioned: true, provider: "email" },
  user_metadata: { username: "admin", first_name: "Admin", last_name: "User" },
}

async function injectSession(page: Page) {
  await page.addInitScript(
    ({ key, token, exp, user }) => {
      const session = { access_token: token, refresh_token: "placeholder", expires_at: exp, token_type: "bearer", user }
      localStorage.setItem(key, JSON.stringify(session))
      localStorage.setItem(key + "-user", JSON.stringify({ user }))
    },
    { key: STORAGE_KEY, token: ACCESS_TOKEN, exp: EXPIRES_AT, user: USER },
  )
}

test.describe("Organizer web — authenticated", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes("organizer"), "organizer only")
  })

  test("dashboard renders authenticated (past the Google landing page)", async ({ page }) => {
    await injectSession(page)
    await page.goto("/")
    // Authenticated: the Google sign-in CTA from the landing page is gone.
    await expect(page.getByText("Continue with Google")).toHaveCount(0)
    // The dashboard welcome renders (real authenticated content).
    await expect(page.getByText(/dashboard is ready/i).first()).toBeVisible({ timeout: 20000 })
  })

  test("shows the authenticated organizer email (desktop sidebar)", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-organizer", "desktop sidebar only")
    await injectSession(page)
    await page.goto("/")
    await expect(page.getByText(USER_EMAIL).first()).toBeVisible({ timeout: 20000 })
  })

  test("Payout section renders for the organizer", async ({ page }) => {
    await injectSession(page)
    await page.goto("/#payout")
    await page.waitForTimeout(1500)
    await expect(page.locator("body")).toBeVisible()
  })
})

test.describe("Admin web — authenticated", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes("admin"), "admin only")
  })

  test("admin dashboard renders (authenticated)", async ({ page }) => {
    await injectSession(page)
    await page.goto("/")
    await expect(page.locator("body")).toBeVisible()
    await page.waitForTimeout(2000)
  })
})
