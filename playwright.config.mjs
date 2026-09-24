import { defineConfig, devices } from "@playwright/test";

/**
 * Acceptance tests run the real extension modules against the fixtures via the
 * harness, with the stub AI server standing in for a provider. Install first:
 *   npm i -D @playwright/test && npx playwright install chromium
 * Then: npm run test:e2e
 */
export default defineConfig({
  testDir: "./test-pages",
  testMatch: /.*\.spec\.mjs/,
  timeout: 15000,
  use: { baseURL: "http://localhost:8730", ...devices["Desktop Chrome"] },
  webServer: {
    command: "node test-pages/stub-server.mjs",
    url: "http://localhost:8730",
    reuseExistingServer: true,
    stdout: "ignore",
  },
});
