const test = require("node:test");
const assert = require("node:assert/strict");
const presence = require("../src/services/presence.service");
const db = require("../src/config/db");
const registerSocketHandlers = require("../src/sockets");

test("an immediate room join waits for presence initialization without being lost", async (t) => {
  let finishInitialization;
  t.mock.method(
    presence,
    "socketConnected",
    () =>
      new Promise((resolve) => {
        finishInitialization = () => resolve(1);
      }),
  );
  for (const method of ["userJoinedRoom"])
    t.mock.method(presence, method, async () => {});
  for (const method of ["getRoomOnlineUsers", "getTypingUsers"])
    t.mock.method(presence, method, async () => []);
  t.mock.method(presence, "startHeartbeatSweep", () => {});
  const userId = "00000000-0000-4000-8000-000000000001";
  const sid = "00000000-0000-4000-8000-000000000002";
  t.mock.method(db.pool, "query", async () => ({
    rows: [{ expires_at: new Date(Date.now() + 60000) }],
  }));
  t.mock.method(db.pool, "connect", async () => ({
    query: async () => ({ rows: [{}] }),
    release() {},
  }));
  let connect;
  const io = {
    use() {},
    on(event, handler) {
      if (event === "connection") connect = handler;
    },
    to() {
      return { emit() {} };
    },
  };
  registerSocketHandlers(io);
  const handlers = new Map();
  let joined;
  connect({
    id: "socket-id",
    user: { id: userId },
    connected: true,
    data: { sessionId: sid },
    authClaims: { sub: userId, sid },
    sessionExpiresAt: Date.now() + 60000,
    disconnect() {},
    broadcast: { emit() {} },
    emit() {},
    on: (event, handler) => handlers.set(event, handler),
    join: (roomId) => {
      joined = roomId;
    },
  });
  assert.ok(handlers.has("join-room"));
  const pending = handlers.get("join-room")({ roomId: "room-id" });
  while (!finishInitialization)
    await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(joined, "room-id");
  finishInitialization();
  await pending;
  assert.equal(joined, "room-id");
});
