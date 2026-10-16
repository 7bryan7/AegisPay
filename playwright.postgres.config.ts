import { defineConfig } from "@playwright/test";

export default defineConfig({
  outputDir: "test-results/postgres",
  testDir: "./tests/e2e-durable", testMatch: "**/*.spec.ts", workers: 1, fullyParallel: false,
  forbidOnly: Boolean(process.env.CI), retries: 0, reporter: "list", timeout: 120000,
  use: { baseURL: "http://127.0.0.1:3300", ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  webServer: [
    { command: "node --import tsx tests/e2e-durable/server.ts", url: "http://127.0.0.1:4300/health", reuseExistingServer: false, timeout: 60000 },
    { command: "node node_modules/next/dist/bin/next dev apps/web --port 3300", url: "http://127.0.0.1:3300",
      env: { NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:4300" }, reuseExistingServer: false, timeout: 120000 }
  ]
});
