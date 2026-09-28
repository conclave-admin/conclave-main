const { redisClient } = require('../config/redis');

// Redis key schema:
//   online_users                    SET   — all connected user IDs
//   room:{roomId}:online            SET   — user IDs currently in this Socket.IO room
//   user:{userId}:rooms             SET   — room IDs this user is in, so a
//                                               disconnect can clean up without
//                                               scanning the whole keyspace
//   typing:{roomId}:{userId}        STRING with TTL — typing indicator
//   presence:{userId}:heartbeat     STRING with TTL — last heartbeat timestamp
//
// Heartbeat: client sends a `heartbeat` event every 30s.
// Server sets `presence:{userId}:heartbeat` with a 45s TTL.
// A periodic sweep removes users from `online_users` whose
// heartbeat key has expired (network drop without clean disconnect).
//
// Note: nothing here uses KEYS. KEYS is O(N) over the entire keyspace and
// blocks the single-threaded server for the duration, so on a busy instance a
// disconnect could stall every other client. Pattern lookups use SCAN, and
// per-user room membership is tracked explicitly (BACKEND_TASKS.md Bug 13).

const HEARTBEAT_TTL_SECONDS = 45;
const HEARTBEAT_SWEEP_INTERVAL_MS = 30_000; // check every 30s
const TYPING_TTL_SECONDS = 5;
const SCAN_COUNT = 100;

const userRoomsKey = (userId) => `user:${userId}:rooms`;

// SCAN a pattern without blocking. Returns every matching key.
async function scanKeys(pattern) {
  const found = [];
  for await (const keys of redisClient.scanIterator({
    MATCH: pattern,
    COUNT: SCAN_COUNT,
  })) {
    found.push(...keys);
  }
  return found;
}

// ---------- Presence ----------

async function userConnected(userId) {
  if (!redisClient.isOpen) return;
  await redisClient.sAdd('online_users', userId);
  await redisClient.set(
    `presence:${userId}:heartbeat`,
    Date.now().toString(),
    { EX: HEARTBEAT_TTL_SECONDS },
  );
}

async function userDisconnected(userId) {
  if (!redisClient.isOpen) return;
  await redisClient.sRem('online_users', userId);
  await redisClient.del(`presence:${userId}:heartbeat`);
}

async function refreshHeartbeat(userId) {
  if (!redisClient.isOpen) return;
  await redisClient.set(
    `presence:${userId}:heartbeat`,
    Date.now().toString(),
    { EX: HEARTBEAT_TTL_SECONDS },
  );
}

/**
 * Sweep online_users: remove anyone whose heartbeat key has expired.
 * Call this on a timer. Returns the list of stale userIds that were removed.
 */
async function sweepStaleUsers() {
  if (!redisClient.isOpen) return [];

  const onlineUserIds = await redisClient.sMembers('online_users');
  if (onlineUserIds.length === 0) return [];

  // Pipeline the heartbeat lookups. This used to await one EXISTS at a time,
  // which is a full round trip per online user every 30 seconds.
  const pipeline = redisClient.multi();
  for (const uid of onlineUserIds) {
    pipeline.exists(`presence:${uid}:heartbeat`);
  }
  const results = await pipeline.exec();

  const stale = [];
  onlineUserIds.forEach((uid, index) => {
    if (results[index] === 0) stale.push(uid);
  });

  if (stale.length > 0) {
    await redisClient.sRem('online_users', stale);
  }

  return stale;
}

async function isUserOnline(userId) {
  if (!redisClient.isOpen) return false;
  return (await redisClient.sIsMember('online_users', userId)) === 1;
}

async function getOnlineUsers() {
  if (!redisClient.isOpen) return [];
  return redisClient.sMembers('online_users');
}

// ---------- Socket connection counting ----------
//
// Presence is tracked per user, but a user can hold several sockets (two
// tabs). Counting sockets prevents "closing one tab" from broadcasting
// user-offline while the other tab is still connected
// (BACKEND_TASKS.md Bug 13).

// Returns the number of sockets this user now has open.
async function socketConnected(userId, socketId) {
  if (!redisClient.isOpen) return 1;
  const key = `user:${userId}:sockets`;
  await redisClient.sAdd(key, socketId);
  return redisClient.sCard(key);
}

// Removes a socket and returns how many the user still has open.
async function socketDisconnected(userId, socketId) {
  if (!redisClient.isOpen) return 0;
  const key = `user:${userId}:sockets`;
  await redisClient.sRem(key, socketId);
  const remaining = await redisClient.sCard(key);
  if (remaining === 0) await redisClient.del(key);
  return remaining;
}

// ---------- Per-room presence ----------

async function userJoinedRoom(userId, roomId) {
  if (!redisClient.isOpen) return;
  await redisClient.sAdd(`room:${roomId}:online`, userId);
  // Track the reverse index so cleanupUserFromRooms does not have to scan.
  await redisClient.sAdd(userRoomsKey(userId), roomId);
}

async function userLeftRoom(userId, roomId) {
  if (!redisClient.isOpen) return;
  await redisClient.sRem(`room:${roomId}:online`, userId);
  await redisClient.sRem(userRoomsKey(userId), roomId);
}

async function getRoomOnlineUsers(roomId) {
  if (!redisClient.isOpen) return [];
  return redisClient.sMembers(`room:${roomId}:online`);
}

/**
 * Clean up a user from all room presence sets (called on disconnect).
 * Returns the list of roomIds they were in, so the caller can
 * broadcast user-offline to each room if needed.
 */
async function cleanupUserFromRooms(userId) {
  if (!redisClient.isOpen) return [];

  // Read the reverse index we maintain rather than scanning room:*:online.
  const roomIds = await redisClient.sMembers(userRoomsKey(userId));
  if (roomIds.length === 0) return [];

  await redisClient.del(userRoomsKey(userId));

  const pipeline = redisClient.multi();
  for (const roomId of roomIds) {
    pipeline.sRem(`room:${roomId}:online`, userId);
  }
  await pipeline.exec();

  return roomIds;
}

// ---------- Typing indicators ----------

async function setTyping(roomId, userId) {
  if (!redisClient.isOpen) return;
  await redisClient.set(
    `typing:${roomId}:${userId}`,
    '1',
    { EX: TYPING_TTL_SECONDS },
  );
}

async function clearTyping(roomId, userId) {
  if (!redisClient.isOpen) return;
  await redisClient.del(`typing:${roomId}:${userId}`);
}

/**
 * Get all users currently typing in a room.
 * Returns an array of userId strings.
 */
async function getTypingUsers(roomId) {
  if (!redisClient.isOpen) return [];
  const keys = await scanKeys(`typing:${roomId}:*`);
  // Extract userId from key format "typing:{roomId}:{userId}"
  return keys.map((k) => k.split(':')[2]);
}

/**
 * Clean up all typing indicators for a user across all rooms (on disconnect).
 */
async function cleanupUserTyping(userId) {
  if (!redisClient.isOpen) return;
  const keys = await scanKeys(`typing:*:${userId}`);
  if (keys.length > 0) {
    await redisClient.del(keys);
  }
}

// ---------- Sweep timer ----------

let sweepTimer = null;

function startHeartbeatSweep(io) {
  if (sweepTimer) return;

  sweepTimer = setInterval(async () => {
    const staleUsers = await sweepStaleUsers();
    for (const userId of staleUsers) {
      io.emit('user-offline', { userId });
    }
  }, HEARTBEAT_SWEEP_INTERVAL_MS);

  // Don't keep the process alive just for the sweep timer
  if (sweepTimer.unref) sweepTimer.unref();
}

function stopHeartbeatSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = {
  // Presence
  userConnected,
  userDisconnected,
  refreshHeartbeat,
  sweepStaleUsers,
  isUserOnline,
  getOnlineUsers,
  startHeartbeatSweep,
  stopHeartbeatSweep,
  // Socket counting
  socketConnected,
  socketDisconnected,
  // Per-room presence
  userJoinedRoom,
  userLeftRoom,
  getRoomOnlineUsers,
  cleanupUserFromRooms,
  // Typing
  setTyping,
  clearTyping,
  getTypingUsers,
  cleanupUserTyping,
};
