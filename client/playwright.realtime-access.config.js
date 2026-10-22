import base from './playwright.config.js';

export default {
  ...base,
  timeout: 90000,
  expect: { timeout: 20000 },
  testMatch: 'realtime-access.spec.js',
  outputDir: './e2e/test-results/realtime-access',
  projects: base.projects.filter(project => project.name.startsWith('app-')).map(project => ({
    ...project, use: { ...project.use, baseURL: 'http://localhost:5186' },
  })),
  webServer: [{ ...base.webServer[0], command: 'npm run dev -- --port 5186', url: 'http://localhost:5186' }],
};
