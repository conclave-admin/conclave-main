import { defineConfig } from "@playwright/test";
// Uses real local API/Redis + a disposable DB and real private R2 objects.
// It does not enable direct uploads or change any bucket/deployment settings.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "media-live.spec.js",
  outputDir: "./e2e/test-results/live",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 20000 },
  use: {
    baseURL: "http://localhost:5177",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "live-desktop", use: { viewport: { width: 1280, height: 800 } } },
    {
      name: "live-mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: [
    {
      command: "node scripts/media-live-server.js",
      cwd: "../backend",
      url: "http://localhost:7100/ready",
      reuseExistingServer: false,
      timeout: 120000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 60000 },
    },
    {
      command: "npm run dev -- --port 5177",
      url: "http://localhost:5177",
      reuseExistingServer: false,
      timeout: 90000,
      env: {
        ...process.env,
        VITE_DEV_AUTH_BYPASS: "false",
        VITE_API_URL: "http://localhost:7100/api",
        VITE_SOCKET_URL: "http://localhost:7100",
        CHOKIDAR_USEPOLLING: "true",
      },
    },
  ],
});
