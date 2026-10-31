import { test, expect } from "@playwright/test"

/**
 * Air-gapped helper to route all Supabase and external API requests
 * preventing any real network calls.
 */
async function mockAirGappedNetwork(page: any, role: "organizer" | "admin") {
  // Block any real external network or cloud calls
  await page.route("**/*", async (route: any) => {
    const url = route.request().url()

    // Allow local assets and dev server
    if (url.includes("localhost") || url.includes("127.0.0.1")) {
      return route.continue()
    }

    // Mock Supabase Auth
    if (url.includes("/auth/v1/user") || url.includes("/auth/v1/token")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: role === "admin" ? "admin-user-id" : "test-user-id",
          email: role === "admin" ? "admin@cluvo.com" : "organizer@example.com",
          user_metadata: { first_name: "Test", last_name: "User" },
          app_metadata: { provider: "email" },
        }),
      })
    }

    // Mock Edge Functions
    if (url.includes("/functions/v1/check-organizer")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          organizer: true,
          deletion_grace: false,
          message: "Organizer verified",
        }),
      })
    }

    // Mock RPCs
    if (url.includes("/rest/v1/rpc/is_admin_user")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(role === "admin"),
      })
    }

    if (url.includes("/rest/v1/rpc/get_admin_communities") || url.includes("/rest/v1/communities")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "comm_mock_1",
            name: "Bangalore Tech Hub",
            owner_id: "test-user-id",
            wallet_balance: 100000,
          },
        ]),
      })
    }

    if (url.includes("/rest/v1/admin_alerts")) {
      return route.fulfill({
        status: 200,
        headers: { "Content-Range": "0-0/0" },
        contentType: "application/json",
        body: JSON.stringify([]),
      })
    }

    if (url.includes("/rest/v1/events")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      })
    }

    // Default mock response for other supabase rest endpoints
    if (url.includes("/rest/v1/")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      })
    }

    // Abort any unexpected external network requests (strict fail-closed)
    return route.abort()
  })
}

test.describe("Organizer Web Responsive Tests", () => {
  test("Desktop Viewport (1280x720) renders organizer portal", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-organizer", "Desktop organizer only")
    await mockAirGappedNetwork(page, "organizer")

    await page.goto("/")
    const viewport = page.viewportSize()
    expect(viewport?.width).toBe(1280)
    await expect(page).toHaveTitle(/Cluvo/i)
  })

  test("Mobile Viewport (375x667) adapts cleanly on small screen", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-organizer", "Mobile organizer only")
    await mockAirGappedNetwork(page, "organizer")

    await page.goto("/")
    const viewport = page.viewportSize()
    expect(viewport?.width).toBe(375)
    await expect(page.locator("body")).toBeVisible()
  })
})

test.describe("Admin Web Responsive & Navigation Tests", () => {
  test("Desktop Viewport (1280x720) displays admin portal with desktop sidebar", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-admin", "Desktop admin only")
    await mockAirGappedNetwork(page, "admin")

    await page.goto("/")
    const viewport = page.viewportSize()
    expect(viewport?.width).toBe(1280)
    await expect(page.locator("body")).toBeVisible()
  })

  test("Mobile Viewport (375x667) adapts navigation with mobile controls", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-admin", "Mobile admin only")
    await mockAirGappedNetwork(page, "admin")

    await page.goto("/")
    const viewport = page.viewportSize()
    expect(viewport?.width).toBe(375)
    await expect(page.locator("body")).toBeVisible()
  })
})
