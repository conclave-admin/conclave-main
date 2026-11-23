import test from "node:test";
import assert from "node:assert/strict";
import { getActiveRoomId, setActiveRoomId } from "../src/lib/activeRoom.js";

// The in-app toast/sound alert skips the conversation this tab already has
// open. That decision reads this module synchronously off `chat:updated`, so
// its contract is deliberately tiny: set, read, clear.
test("the active room is set while a conversation is open and cleared on leave", () => {
  setActiveRoomId("room-1");
  assert.equal(getActiveRoomId(), "room-1");

  // Room.jsx cleans up with `setActiveRoomId(null)` when the route unmounts,
  // so a later message for the same room must alert again.
  setActiveRoomId(null);
  assert.equal(getActiveRoomId(), null);

  // An empty/undefined id is treated as "nothing open", never as a falsy
  // room id that could match a real conversation.
  setActiveRoomId(undefined);
  assert.equal(getActiveRoomId(), null);
});

test("switching conversations replaces the previous active room", () => {
  setActiveRoomId("room-1");
  setActiveRoomId("room-2");
  assert.equal(getActiveRoomId(), "room-2");
  setActiveRoomId(null);
});
