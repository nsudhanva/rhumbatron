import { defineConfig } from "vitest/config";

// Pure-logic critical tests only. A separate config keeps the app's Vite plugins
// (vite.config.ts: TanStack Start and the Cloudflare Worker build) out of the test run.
export default defineConfig({
  test: { include: ["**/*.critical.test.ts"] },
});
