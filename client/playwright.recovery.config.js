import base from "./playwright.realtime-access.config.js";

export default {
  ...base,
  testMatch: ["realtime-access.spec.js", "recovery-notifications.spec.js", "release-regressions.spec.js", "messaging-layout.spec.js", "account-notification-polish.spec.js"],
  outputDir: "./e2e/test-results/recovery",
};
