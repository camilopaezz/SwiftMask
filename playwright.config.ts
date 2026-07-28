import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Must use VITE_E2E=1 so Tauri APIs resolve to e2e/mocks. Never reuse a
    // normal `bun run dev` server on :5173 — mocks would be missing and the UI
    // crashes before "Drop an image here" appears.
    command: "VITE_E2E=1 bun run dev",
    url: "http://localhost:5173",
    reuseExistingServer: process.env.REUSE_E2E_SERVER === "1",
    timeout: 120_000,
  },
});
