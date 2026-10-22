import base from './playwright.realtime-access.config.js';

export default {
  ...base,
  testMatch: ['realtime-access.spec.js', 'recovery-notifications.spec.js'],
  outputDir: './e2e/test-results/recovery',
};
