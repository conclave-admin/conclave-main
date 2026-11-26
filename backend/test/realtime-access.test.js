const test = require("node:test");
const assert = require("node:assert/strict");
const presence = require("../src/services/presence.service");
const {
  revokeRoomAccess,
  registerAccessControl,
} = require("../src/services/realtimeAccess.service");

test("room revocation waits for every peer before cleaning presence", async (t) => {
  const calls = [];
  t.mock.method(presence, "revokeUserRoom", async () => calls.push("presence"));
  const io = {
    of: () => ({
      sockets: new Map([
        [
          "one",
          { user: { id: "member" }, leave: async () => calls.push("local") },
        ],
      ]),
      adapter: { serverCount: async () => 2 },
    }),
    serverSideEmitWithAck: async (name, request) => {
      calls.push("peer");
      assert.equal(request.userId, "member");
      return [{ ok: true }];
    },
  };
  await revokeRoomAccess(io, "room", "member");
  assert.deepEqual(calls, ["local", "peer", "presence"]);
});

test("a failed peer fails revocation instead of declaring success", async (t) => {
  let cleaned = false;
  t.mock.method(presence, "revokeUserRoom", async () => {
    cleaned = true;
  });
  const io = {
    of: () => ({ sockets: new Map(), adapter: { serverCount: async () => 2 } }),
    serverSideEmitWithAck: async () => [{ ok: false }],
  };
  await assert.rejects(
    revokeRoomAccess(io, "room", "member"),
    (error) => error.status === 503,
  );
  assert.equal(cleaned, false);
});

test("peer acknowledges only after its local sockets leave", async () => {
  let handler;
  let left = false;
  const io = {
    on: (name, callback) => {
      handler = callback;
    },
    of: () => ({
      sockets: new Map([
        [
          "one",
          {
            user: { id: "member" },
            leave: async () => {
              left = true;
            },
          },
        ],
      ]),
    }),
  };
  registerAccessControl(io);
  await handler(
    { kind: "room", roomId: "room", userId: "member" },
    (result) => {
      assert.equal(left, true);
      assert.equal(result.ok, true);
    },
  );
});
