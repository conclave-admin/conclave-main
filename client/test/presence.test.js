import test from "node:test";
import assert from "node:assert/strict";
import {
  presenceStatus,
  roomPresenceSnapshot,
  presenceLabel,
} from "../src/lib/presenceState.js";
import { startPresenceHeartbeat } from "../src/lib/presenceHeartbeat.js";

test("online, viewing, typing, offline and unknown have distinct meanings", () => {
  const state = roomPresenceSnapshot(
    {
      available: true,
      onlineUserIds: ["connected", "viewing", "typing"],
      viewingUserIds: ["viewing", "typing"],
      typingUserIds: ["typing"],
    },
    100,
  );
  assert.equal(presenceStatus(state, "connected", true, 101), "online");
  assert.equal(presenceStatus(state, "viewing", true, 101), "viewing");
  assert.equal(presenceStatus(state, "typing", true, 101), "typing");
  assert.equal(presenceStatus(state, "absent", true, 101), "offline");
  assert.equal(presenceStatus(state, "typing", false, 101), "unknown");
  assert.equal(presenceStatus(null, "typing", true, 101), "unknown");
  assert.equal(presenceStatus(state, "typing", true, 45100), "unknown");
  assert.equal(
    presenceStatus(state, "typing", true, 5101),
    "viewing",
    "typing expires without another event",
  );
  assert.equal(
    presenceStatus(roomPresenceSnapshot({ available: false }), "absent"),
    "unknown",
  );
  assert.equal(presenceLabel("unknown"), "Presence unavailable");
});

function fixture() {
  const doc = new EventTarget();
  const win = new EventTarget();
  doc.visibilityState = "visible";
  doc.focused = true;
  doc.hasFocus = () => doc.focused;
  const callbacks = new Map();
  const calls = [];
  let tick;
  let revision = 0;
  let clock = 100;
  const socket = {
    connected: true,
    on: (name, handler) => callbacks.set(name, handler),
    off: (name) => callbacks.delete(name),
    emit: (name, payload, acknowledge) => {
      calls.push({ name, payload });
      acknowledge?.({ ok: true, data: { available: true } });
    },
  };
  const stop = startPresenceHeartbeat(socket, {
    roomId: "room-a",
    nextRevision: () => ++revision,
    document: doc,
    window: win,
    now: () => clock,
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  });
  return {
    doc,
    win,
    socket,
    callbacks,
    calls,
    stop,
    tick: () => tick?.(),
    setTime: (value) => {
      clock = value;
    },
  };
}
test("background, focus, page freeze and resume immediately update attention", () => {
  const f = fixture();
  assert.equal(f.calls.at(-1).payload.foreground, true);
  f.doc.visibilityState = "hidden";
  f.doc.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(f.calls.at(-1).payload, {
    foreground: false,
    roomId: null,
    revision: 2,
  });
  f.doc.visibilityState = "visible";
  f.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(f.calls.at(-1).payload.roomId, "room-a");
  f.doc.focused = false;
  f.win.dispatchEvent(new Event("blur"));
  assert.equal(f.calls.at(-1).payload.foreground, false);
  f.doc.focused = true;
  f.win.dispatchEvent(new Event("focus"));
  assert.equal(f.calls.at(-1).payload.foreground, true);
  f.win.dispatchEvent(new Event("pagehide"));
  const count = f.calls.length;
  f.tick();
  assert.equal(f.calls.length, count);
  f.win.dispatchEvent(new Event("pageshow"));
  assert.equal(f.calls.at(-1).payload.foreground, true);
  f.stop();
  const after = f.calls.length;
  f.win.dispatchEvent(new Event("focus"));
  f.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(f.calls.length, after);
  assert.equal(f.callbacks.size, 0);
});
test("sleep invalidates cached presence before renewing and reconnects start fresh", () => {
  const f = fixture();
  let stale = 0;
  f.win.addEventListener("conclave:presence-stale", () => stale++);
  f.setTime(50000);
  f.tick();
  assert.equal(stale, 1);
  f.socket.connected = false;
  f.callbacks.get("disconnect")();
  const count = f.calls.length;
  f.tick();
  assert.equal(f.calls.length, count);
  f.socket.connected = true;
  f.callbacks.get("connect")();
  assert.equal(f.calls.length, count + 1);
  f.callbacks.get("presence:resync")();
  assert.equal(f.calls.length, count + 2);
  f.stop();
});
