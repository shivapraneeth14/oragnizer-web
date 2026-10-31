import { defineConfig, devices } from "@playwright/test"

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "desktop-organizer",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        baseURL: "http://localhost:5173",
      },
    },
    {
      name: "mobile-organizer",
      use: {
        viewport: { width: 375, height: 667 },
        isMobile: true,
        baseURL: "http://localhost:5173",
      },
    },
    {
      name: "desktop-admin",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        baseURL: "http://localhost:5174",
      },
    },
    {
      name: "mobile-admin",
      use: {
        viewport: { width: 375, height: 667 },
        isMobile: true,
        baseURL: "http://localhost:5174",
      },
    },
  ],
  webServer: [
    {
      command: "npm --prefix apps/organizer-web run dev -- --port 5173 --host",
      port: 5173,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "npm --prefix apps/admin-web run dev -- --port 5174 --host",
      port: 5174,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
})

