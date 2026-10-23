import test from "node:test";
import assert from "node:assert/strict";
import {
  allowsAutomaticDownload,
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
