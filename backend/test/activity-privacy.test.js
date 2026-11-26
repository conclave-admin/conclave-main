const test = require("node:test");
const assert = require("node:assert/strict");
const { filterPresence } = require("../src/services/presence.service");
test("blocks in either direction filter every ephemeral field and member internals", () => {
  const state = {
    roomId: "room",
    available: true,
    memberIds: ["a", "b", "c"],
    onlineUserIds: ["a", "b", "c"],
    viewingUserIds: ["b", "c"],
    typingUserIds: ["b"],
    recordingUserIds: ["c"],
    activity: [
      { userId: "b", kind: "typing" },
      { userId: "c", kind: "recording" },
    ],
  };
  for (const pair of [
    { blocker_id: "a", blocked_id: "b" },
    { blocker_id: "b", blocked_id: "a" },
  ]) {
    const result = filterPresence(state, "a", [pair]);
    assert.equal(result.memberIds, undefined);
    assert.ok(!result.onlineUserIds.includes("b"));
    assert.ok(!result.typingUserIds.includes("b"));
    assert.ok(result.recordingUserIds.includes("c"));
    assert.equal(result.activity.length, 1);
  }
  assert.equal(
    state.typingUserIds.length,
    1,
    "one recipient does not mutate another recipient’s snapshot",
  );
});
