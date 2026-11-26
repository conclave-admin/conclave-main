import test from "node:test";
import assert from "node:assert/strict";
import {
  allowsAutomaticDownload,
  getMediaPreferences,
  networkSnapshot,
} from "../src/lib/mediaPreferences.js";
import {
  videoCompressionSupported,
  MAX_VIDEO_INPUT_BYTES,
} from "../src/lib/videoCompression.js";
import { draftMessage } from "../src/lib/outbox.js";

test("network restrictions are conservative for unknown connections and respect Data Saver", () => {
  const any = { network: "any", respectSaveData: true };
  assert.equal(allowsAutomaticDownload(any, networkSnapshot()), true);
  assert.equal(allowsAutomaticDownload(any, { saveData: true }), false);
  assert.equal(
    allowsAutomaticDownload(
      { ...any, network: "unmetered" },
      { type: "unknown" },
    ),
    false,
  );
  for (const type of ["wifi", "ethernet"])
    assert.equal(
      allowsAutomaticDownload({ ...any, network: "unmetered" }, { type }),
      true,
    );
  assert.equal(
    allowsAutomaticDownload(
      { ...any, network: "unmetered" },
      { type: "cellular" },
    ),
    false,
  );
  assert.equal(
    allowsAutomaticDownload(
      { ...any, network: "fast" },
      { effectiveType: "4g" },
    ),
    true,
  );
  assert.equal(
    allowsAutomaticDownload(
      { ...any, network: "fast" },
      { effectiveType: "3g" },
    ),
    false,
  );
  assert.equal(
    allowsAutomaticDownload(
      { ...any, respectSaveData: false },
      { saveData: true },
    ),
    true,
  );
  assert.equal(allowsAutomaticDownload(any, {}, false), false);
});

test("automatic media downloads default to Wi-Fi and cellular downloads remain opt-in", () => {
  const preferences = getMediaPreferences();
  assert.equal(preferences.network, "unmetered");
  assert.equal(allowsAutomaticDownload(preferences, { type: "wifi" }), true);
  assert.equal(allowsAutomaticDownload(preferences, { type: "ethernet" }), true);
  assert.equal(allowsAutomaticDownload(preferences, { type: "cellular" }), false);
  assert.equal(allowsAutomaticDownload(preferences, { type: "unknown" }), false);
  assert.equal(
    allowsAutomaticDownload({ ...preferences, network: "any" }, { type: "cellular" }),
    true,
  );
});

test("legacy implicit any-connection settings migrate while explicit choices persist", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let value = JSON.stringify({ network: "any", images: false });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => value },
  });
  try {
    const migrated = getMediaPreferences();
    assert.equal(migrated.network, "unmetered");
    assert.equal(migrated.images, false);

    value = JSON.stringify({ network: "any", networkExplicit: true });
    assert.equal(getMediaPreferences().network, "any");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("video compression reports unsupported environments and limits local input", () => {
  assert.equal(videoCompressionSupported(), false);
  assert.equal(MAX_VIDEO_INPUT_BYTES, 200 * 1024 * 1024);
});
test("forward previews remain separate from upload claims in pending messages", () => {
  const file = {
    id: "source-file",
    url: "r2://private/file",
    mime_type: "image/png",
  };
  const item = {
    tempId: "pending",
    clientId: "stable",
    roomId: "target",
    userId: "me",
    createdAt: Date.now(),
    payload: {
      content: "Caption",
      attachments: [],
      forwardSource: { messageId: "source" },
    },
    forwardPreview: [file],
  };
  const row = draftMessage(item);
  assert.equal(row.forwarded, true);
  assert.deepEqual(row.attachments, [file]);
  assert.deepEqual(item.payload.attachments, []);
});
