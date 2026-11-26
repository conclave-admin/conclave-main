import test from "node:test";
import assert from "node:assert/strict";
import {
  createActivitySender,
  activityExpiries,
  activeUserIds,
  acceptsActivity,
} from "../src/lib/conversationActivity.js";
import {
  roomPresenceSnapshot,
  presenceStatus,
} from "../src/lib/presenceState.js";

function fixture() {
  let clock = 0;
  let sequence = 0;
  let enabled = true;
  const timers = new Map();
  const intervals = new Map();
  const calls = [];
  const sender = createActivitySender({
    typing: () => calls.push("typing"),
    stopTyping: () => calls.push("stop"),
    recording: () => calls.push("recording"),
    stopRecording: () => calls.push("stop-recording"),
    now: () => clock,
    canSignal: () => enabled,
    later: (callback) => {
      timers.set(++sequence, callback);
      return sequence;
    },
    cancel: (id) => timers.delete(id),
    repeat: (callback) => {
      intervals.set(++sequence, callback);
      return sequence;
    },
    stopRepeat: (id) => intervals.delete(id),
  });
  return {
    sender,
    calls,
    timers,
    intervals,
    time: (value) => {
      clock = value;
    },
    enabled: (value) => {
      enabled = value;
    },
  };
}
test("typing throttle runs before emitting and idle or blank input stops immediately", () => {
  const f = fixture();
  for (let index = 0; index < 100; index++) f.sender.textChanged("a");
  assert.deepEqual(f.calls, ["typing"]);
  f.time(2500);
  f.sender.textChanged("ab");
  assert.deepEqual(f.calls, ["typing", "typing"]);
  [...f.timers.values()][0]();
  assert.equal(f.calls.at(-1), "stop");
  f.sender.textChanged("c");
  f.sender.textChanged("   ");
  assert.equal(f.calls.at(-1), "stop");
  f.sender.dispose();
  assert.equal(f.intervals.size, 0);
});
test("recording pulses while active, replaces own typing and disposes all timers", () => {
  const f = fixture();
  f.sender.textChanged("hello");
  f.sender.startRecording();
  assert.deepEqual(f.calls, ["typing", "stop", "recording"]);
  f.sender.textChanged("caption");
  assert.equal(f.calls.at(-1), "recording");
  [...f.intervals.values()][0]();
  assert.equal(f.calls.filter((name) => name === "recording").length, 2);
  f.sender.endRecording();
  assert.equal(f.calls.at(-1), "stop-recording");
  f.sender.dispose();
  assert.equal(f.intervals.size, 0);
  assert.equal(f.timers.size, 0);
});
test("offline or suspended senders do not announce new activity", () => {
  const f = fixture();
  f.enabled(false);
  f.sender.textChanged("hello");
  f.sender.startRecording();
  assert.equal(f.calls.length, 0);
  f.sender.stop();
  f.enabled(true);
  f.sender.textChanged("back");
  f.sender.stop();
  assert.deepEqual(f.calls.slice(-2), ["typing", "stop"]);
});
test("snapshots use remaining lifetimes, expire without events and hide blocked or self activity", () => {
  const state = activityExpiries(
    {
      activity: [
        { userId: "a", kind: "typing", ttlMs: 200 },
        { userId: "b", kind: "typing", ttlMs: 5000 },
        { userId: "self", kind: "typing", ttlMs: 5000 },
      ],
    },
    "typing",
    1000,
  );
  assert.deepEqual(activeUserIds(state, 1100, new Set(["b"]), "self"), ["a"]);
  assert.deepEqual(activeUserIds(state, 1200, new Set(["b"]), "self"), []);
  const snapshot = roomPresenceSnapshot(
    { available: true, onlineUserIds: ["a"], recordingUserIds: ["a"] },
    1000,
  );
  assert.equal(presenceStatus(snapshot, "a", true, 1001), "recording");
  assert.equal(presenceStatus(snapshot, "a", true, 6001), "online");
  assert.equal(
    presenceStatus(
      roomPresenceSnapshot({ available: true, hiddenUserIds: ["a"] }),
      "a",
    ),
    "unknown",
  );
});

test("room versions reject delayed snapshots and deltas after newer activity stops", () => {
  const previous = { activityVersion: 12 };
  assert.equal(acceptsActivity(previous, { activityVersion: 11 }), false);
  assert.equal(acceptsActivity(previous, { activityVersion: 12 }), true);
  assert.equal(acceptsActivity(previous, { activityVersion: 13 }), true);
  assert.equal(acceptsActivity(undefined, { activityVersion: 1 }), true);
  assert.equal(acceptsActivity(previous, {}), true);
});
