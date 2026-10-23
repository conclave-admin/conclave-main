import test from "node:test";
import assert from "node:assert/strict";
import {
  voiceRecordingFile,
  voiceRecorderOptions,
} from "../src/lib/voiceRecording.js";
test("recordings keep supported container names and strip codec parameters", async () => {
  for (const [mime, type, extension] of [
    ["audio/webm;codecs=opus", "audio/webm", "weba"],
    ["audio/ogg; codecs=opus", "audio/ogg", "ogg"],
    ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "m4a"],
  ]) {
    const file = voiceRecordingFile(["recorded bytes"], mime, 123);
    assert.equal(file.type, type);
    assert.equal(file.name, `voice-note-123.${extension}`);
    assert.equal(await file.text(), "recorded bytes");
  }
  assert.throws(
    () => voiceRecordingFile(["bytes"], "video/mp4"),
    /unsupported audio/,
  );
});
test("voice recorder selects an audio container supported by the browser", () => {
  assert.deepEqual(
    voiceRecorderOptions({ isTypeSupported: (type) => type === "audio/mp4" }),
    { mimeType: "audio/mp4" },
  );
  assert.equal(voiceRecorderOptions({}), undefined);
});
