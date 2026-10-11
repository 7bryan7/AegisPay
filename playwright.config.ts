import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3100", ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  webServer: [
    { command: "node --import tsx tests/e2e/server.ts", url: "http://127.0.0.1:4100/health", reuseExistingServer: false, timeout: 30000 },
    { command: "node node_modules/next/dist/bin/next dev apps/web --port 3100", url: "http://127.0.0.1:3100",
      env: { NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:4100" }, reuseExistingServer: false, timeout: 120000 }
  ]
});
