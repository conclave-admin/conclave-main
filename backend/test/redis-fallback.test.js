const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

process.env.REDIS_URL = "";
process.env.SOCKET_REDIS_ADAPTER = "false";

require("../src/config/env").redisUrl = undefined;
const { connectRedis, isRedisReady, redisClient } = require("../src/config/redis");
const presence = require("../src/services/presence.service");
const activity = require("../src/services/conversationActivity.service");

test("API presence and typing stay available without a Redis URL", async () => {
  const userId = randomUUID();
  const socketId = randomUUID();
  const roomId = randomUUID();

  assert.equal(redisClient, null);
  assert.equal(await connectRedis(), false);
  assert.equal(isRedisReady(), false);

  assert.equal(await presence.socketConnected(userId, socketId), 1);
  await presence.userJoinedRoom(userId, roomId, socketId);
  await presence.renewSocket(userId, socketId, {
    foreground: true,
    roomId,
  });
  assert.deepEqual(await presence.getRoomOnlineUsers(roomId), [userId]);
  assert.deepEqual(await presence.getRoomViewingUsers(roomId), [userId]);

  assert.equal(
    await activity.update(roomId, userId, socketId, "typing", true, 1),
    true,
  );
  const [typing] = await activity.snapshot(roomId);
  assert.equal(typing.userId, userId);
  assert.equal(typing.kind, "typing");
  assert.ok(typing.ttlMs > 0 && typing.ttlMs <= activity.TTL_MS);

  await presence.cleanupSocketFromRooms(userId, socketId);
  assert.equal(await presence.socketDisconnected(userId, socketId), 0);
  assert.deepEqual(await presence.getRoomOnlineUsers(roomId), []);
  assert.deepEqual(await activity.snapshot(roomId), []);
});
