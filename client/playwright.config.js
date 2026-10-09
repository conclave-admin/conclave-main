import { defineConfig } from '@playwright/test';

const APP = 'http://localhost:5173';
const PUBLIC = 'http://localhost:5174';

const mobile = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
};

const desktop = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
};

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  /*
   * Two dev servers, because the dev-preview auth bypass is baked into the
   * bundle at dev-server start (`import.meta.env.DEV && VITE_DEV_AUTH_BYPASS`),
   * so it cannot be toggled at runtime from the browser.
   *
   * 5173 is the app: bypass ON, every service returns fixtures, and the
   * visitor is treated as signed in. That covers every authenticated route
   * plus /login and /register, which PublicOnlyRoute deliberately lets
   * through under bypass.
   *
   * 5174 is the public site: bypass OFF via an env override that takes
   * precedence over .env. Without it, LandingRoute sees an authenticated
   * visitor and redirects / straight to /chats, so the marketing page could
   * never be reached. One server exists solely to render Landing.
   */
  projects: [
    { name: 'app-desktop', use: { baseURL: APP, ...desktop } },
    { name: 'app-mobile', use: { baseURL: APP, ...mobile } },
    { name: 'public-desktop', use: { baseURL: PUBLIC, ...desktop } },
    { name: 'public-mobile', use: { baseURL: PUBLIC, ...mobile } },
  ],

  webServer: [
    {
      command: 'npm run dev',
      url: APP,
      reuseExistingServer: true,
      timeout: 90_000,
    },
    {
      command: 'VITE_DEV_AUTH_BYPASS=false npm run dev -- --port 5174',
      url: PUBLIC,
      reuseExistingServer: true,
      timeout: 90_000,
    },
  ],
});
