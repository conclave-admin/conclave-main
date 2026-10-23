import test from "node:test";
import assert from "node:assert/strict";
import { sharedUrls } from "../src/lib/sharedLinks.js";
test("shared link extraction permits HTTP(S), deduplicates and retains balanced URL parentheses", () => {
  assert.deepEqual(
    sharedUrls(
      "See <https://example.test/a> https://example.test/a, http://example.test/(b) and (https://example.test/c).",
    ),
    [
      "https://example.test/a",
      "http://example.test/(b)",
      "https://example.test/c",
    ],
  );
  assert.deepEqual(
    sharedUrls("javascript:alert(1) data:text/html,hello https://"),
    [],
  );
});
