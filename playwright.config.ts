import { defineConfig, devices } from "@playwright/test";

/**
 * UI end-to-end suite against prod (e2e/ui). Signs in as the Clerk prod smoke user in
 * global setup. Run: bun run test:ui (needs CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID).
 */
export default defineConfig({
  testDir: "e2e/ui",
  outputDir: "e2e/.results",
  globalSetup: "./e2e/ui/global-setup.ts",
  fullyParallel: true,
  workers: 4,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: "e2e/.results/report.json" }]],
  use: {
    baseURL: "https://rhumbatron.com",
    storageState: "e2e/.auth/smoke.json",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      // Local DNS blocks the Cloudflare analytics beacon on this machine.
      args: ["--host-resolver-rules=MAP static.cloudflareinsights.com 104.16.80.73"],
    },
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      // Flows that create Projects and Changes run once, on desktop.
      grepInvert: /@desktop-only/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 412, height: 915 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2.625,
      },
    },
  ],
});
