import test from "node:test";
import assert from "node:assert/strict";
import { waveformPeaks, recordingGesture } from "../src/lib/waveform.js";
import {
  automaticMediaType,
  getMediaPreferences,
} from "../src/lib/mediaPreferences.js";
test("waveforms preserve real silence and distinguish signal amplitude", () => {
  assert.deepEqual(waveformPeaks(new Float32Array(100), 4), [0, 0, 0, 0]);
  assert.deepEqual(
    waveformPeaks(new Float32Array([0, 0.25, -0.5, 1]), 4),
    [0, 0.25, 0.5, 1],
  );
  assert.equal(waveformPeaks(new Float32Array(100000).fill(0.5)).length, 48);
});
test("hybrid recording distinguishes cancel, lock and a held recording", () => {
  assert.equal(recordingGesture(-100, 0), "cancel");
  assert.equal(recordingGesture(0, -90), "lock");
  assert.equal(recordingGesture(4, 5), "hold");
  assert.equal(recordingGesture(100, 0), "hold");
});
test("all media types default to background downloads and remain individually configurable", () => {
  const prefs = getMediaPreferences();
  for (const mime_type of [
    "image/png",
    "audio/ogg",
    "video/mp4",
    "application/pdf",
  ])
    assert.equal(automaticMediaType({ mime_type }, prefs), true);
  assert.equal(
    automaticMediaType({ mime_type: "audio/ogg" }, { ...prefs, audio: false }),
    false,
  );
  assert.equal(
    automaticMediaType(
      { mime_type: "application/pdf" },
      { ...prefs, documents: false },
    ),
    false,
  );
});
