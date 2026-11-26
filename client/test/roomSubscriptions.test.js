import test from "node:test";
import assert from "node:assert/strict";
import { subscribeToRoom } from "../src/lib/roomSubscriptions.js";

function socket() {
  const events = [];
  const listeners = new Map();
  return {
    connected: true,
    events,
    listeners,
    emit: (name, payload) => events.push({ name, ...payload }),
    on: (name, handler) => listeners.set(name, handler),
    off: (name) => listeners.delete(name),
  };
}
test("chat and info share one subscription until the last observer leaves", async () => {
  const instance = socket();
  const chat = subscribeToRoom(instance, "room-a");
  const info = subscribeToRoom(instance, "room-a");
  assert.deepEqual(instance.events, [{ name: "join-room", roomId: "room-a" }]);
  chat();
  assert.equal(instance.events.length, 1);
  info();
  info();
  await Promise.resolve();
  assert.deepEqual(instance.events[1], {
    name: "leave-room",
    roomId: "room-a",
  });
  assert.equal(instance.listeners.size, 0);
});
test("each socket reconnect restores only its currently observed room", async () => {
  const a = socket();
  const b = socket();
  const leave = subscribeToRoom(a, "room-a");
  const stop = subscribeToRoom(b, "room-b");
  a.listeners.get("connect")();
  assert.equal(a.events.length, 2);
  assert.equal(b.events.length, 1);
  leave();
  await Promise.resolve();
  assert.equal(a.listeners.has("connect"), false);
  stop();
});

test("route handoff retains the room subscription", async () => {
  const instance = socket();
  const chat = subscribeToRoom(instance, "room-a");
  chat();
  const info = subscribeToRoom(instance, "room-a");
  await Promise.resolve();
  assert.deepEqual(instance.events, [{ name: "join-room", roomId: "room-a" }]);
  info();
  await Promise.resolve();
  assert.equal(instance.events.at(-1).name, "leave-room");
});
