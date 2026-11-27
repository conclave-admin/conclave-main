import { test } from "node:test";
import assert from "node:assert/strict";
import { pushSupport, pushSupportHint } from "../src/lib/pushCapabilities.js";

const browser = (navigator = {}) => ({
  isSecureContext: true,
  Notification: {},
  PushManager: {},
  navigator: { serviceWorker: {}, ...navigator },
  matchMedia: () => ({ matches: false }),
});
test("push capability checks require HTTPS and browser support", () => {
  assert.equal(pushSupport(browser()), true);
  assert.equal(pushSupport({ ...browser(), isSecureContext: false }), false);
  assert.match(pushSupportHint({ ...browser(), isSecureContext: false }), /HTTPS/);
  assert.equal(pushSupport({ ...browser(), PushManager: undefined }), false);
});
test("iPhone and desktop-mode iPad get Home Screen instructions", () => {
  assert.match(pushSupportHint(browser({ userAgent: "iPhone" })), /Home Screen/);
  assert.match(pushSupportHint(browser({ platform: "MacIntel", maxTouchPoints: 5 })), /Home Screen/);
  assert.doesNotMatch(pushSupportHint(browser({ userAgent: "iPhone", standalone: true })), /add Conclave/);
  assert.doesNotMatch(pushSupportHint(browser({ platform: "MacIntel", maxTouchPoints: 0 })), /Home Screen/);
});
