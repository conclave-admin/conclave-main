import { defineConfig } from "@playwright/test";

// Exercises the actual built app and service worker with auth/API mocks.
// Run separately from the Vite fixture suite to verify genuine offline reloads.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "media-offline-production.spec.js",
  outputDir: "./e2e/test-results/production",
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://localhost:5176",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "production-desktop",
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: "production-mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "npm run build && npm run preview -- --port 5176",
    url: "http://localhost:5176",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
