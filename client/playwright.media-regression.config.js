import base from "./playwright.media-followups.config.js";
// Focused media regression checks on isolated port 5181. Authenticated offline
// restoration is checked separately by the production and live configurations.
export default {
  ...base,
  testMatch: [
    "media-albums.spec.js",
    "media-downloads.spec.js",
    "media-outbox.spec.js",
    "media-followups.spec.js",
  ],
  grepInvert: /a real authenticated session restores pending media/,
  outputDir: "./e2e/test-results/media-regression",
};
