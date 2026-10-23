import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "security-encryption.spec.js",
  outputDir: "./e2e/test-results/security",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 25000 },
  use: {
    baseURL: "http://localhost:5188",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "security-desktop",
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: "security-mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: [
    {
      command: "node scripts/security-browser-server.js",
      cwd: "../backend",
      url: "http://localhost:7120/ready",
      timeout: 120000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 30000 },
    },
    {
      command: "npm run dev -- --port 5188",
      url: "http://localhost:5188",
      timeout: 90000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        VITE_DEV_AUTH_BYPASS: "false",
        VITE_API_URL: "http://localhost:7120/api",
        VITE_SOCKET_URL: "http://localhost:7120",
        CHOKIDAR_USEPOLLING: "true",
      },
    },
  ],
});
