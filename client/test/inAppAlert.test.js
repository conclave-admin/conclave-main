import test from "node:test";
import assert from "node:assert/strict";
import { ALERTABLE_TYPES, shouldAlert } from "../src/lib/inAppAlert.js";

const message = (roomId = "room-1", type = "new_message") => ({
  type,
  context: { room_id: roomId, room_name: "General", actor_name: "Priya" },
});

test("an ordinary message in a background conversation alerts", () => {
  assert.equal(shouldAlert({ notification: message() }), true);
  // Every message-shaped type is alertable; the non-message ones never were.
  for (const type of ALERTABLE_TYPES)
    assert.equal(shouldAlert({ notification: message("room-1", type) }), true);
  for (const type of ["room_invite", "member_joined", "task", "decision"])
    assert.equal(shouldAlert({ notification: message("room-1", type) }), false);
});

test("the conversation open in this tab never alerts", () => {
  assert.equal(
    shouldAlert({ notification: message(), activeRoomId: "room-1" }),
    false,
  );
  // A different room still does — that is the whole point of the alert.
  assert.equal(
    shouldAlert({ notification: message(), activeRoomId: "room-2" }),
    true,
  );
});

test("muted and archived rooms are never interrupted", () => {
  assert.equal(
    shouldAlert({ notification: message(), mutedRooms: ["room-1"] }),
    false,
  );
  assert.equal(
    shouldAlert({ notification: message(), archivedRooms: ["room-1"] }),
    false,
  );
});

test("activity level none silences everything and mentions allows only mentions", () => {
  assert.equal(
    shouldAlert({
      notification: message("room-1", "mention"),
      policy: { activityLevel: "none" },
    }),
    false,
  );
  assert.equal(
    shouldAlert({
      notification: message("room-1", "new_message"),
      policy: { activityLevel: "mentions" },
    }),
    false,
  );
  assert.equal(
    shouldAlert({
      notification: message("room-1", "mention"),
      policy: { activityLevel: "mentions" },
    }),
    true,
    "a mention is exactly what 'mentions' is for",
  );
  assert.equal(
    shouldAlert({
      notification: message("room-1", "new_message"),
      policy: { activityLevel: "all" },
    }),
    true,
  );
});

test("a per-type mute and the in-app alerts switch each suppress their own case", () => {
  assert.equal(
    shouldAlert({
      notification: message("room-1", "new_message"),
      policy: { muted: { new_message: true } },
    }),
    false,
  );
  // The map only silences the type it names.
  assert.equal(
    shouldAlert({
      notification: message("room-1", "mention"),
      policy: { muted: { new_message: true } },
    }),
    true,
  );
  assert.equal(
    shouldAlert({
      notification: message(),
      policy: { inAppAlerts: false },
    }),
    false,
  );
});

test("do-not-disturb suppresses only while the window is current", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  assert.equal(
    shouldAlert({
      notification: message(),
      policy: { dndUntil: "2026-06-01T13:00:00Z" },
      now,
    }),
    false,
  );
  assert.equal(
    shouldAlert({
      notification: message(),
      policy: { dndUntil: "2026-06-01T11:00:00Z" },
      now,
    }),
    true,
    "an expired window is the same as no window",
  );
  // Malformed or absent values are treated as off rather than throwing.
  assert.equal(shouldAlert({ notification: message(), now }), true);
});

test("a notification without a resolvable room cannot be opened, so it cannot alert", () => {
  assert.equal(shouldAlert({ notification: { type: "new_message" } }), false);
  assert.equal(
    shouldAlert({ notification: { type: "new_message", context: {} } }),
    false,
  );
  assert.equal(shouldAlert({ notification: null }), false);
});
