const { redisClient } = require('../config/redis');
const { query } = require('../config/db');
const activity = require('./conversationActivity.service');

// A lease belongs to one socket, never an entire user. The sorted-set member
// contains the owner so a crash can be cleaned up even if its hash is missing.
const LEASE_MS = 45000;
const LEASES = 'presence:leases';
const userRoomsKey = id => `user:${id}:rooms`;
const socketRoomsKey = id => `socket:${id}:rooms`;
const socketKey = id => `presence:socket:${id}`;
const roomUserSocketsKey = (room, user) => `room:${room}:user:${user}:sockets`;
const memberKey = (user, socket) => `${user}:${socket}`;
const ready = () => redisClient.isReady;
const pendingCleanup = new Set();
function trackCleanup(work) {
  pendingCleanup.add(work);
  work.then(() => pendingCleanup.delete(work), () => pendingCleanup.delete(work));
  return work;
}
async function drainCleanup() {
  while (pendingCleanup.size) await Promise.allSettled([...pendingCleanup]);
}

async function scanKeys(pattern) {
  const found = [];
  for await (const item of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    found.push(...(Array.isArray(item) ? item : [item]));
  }
  return found;
}

async function renewSocket(userId, socketId, { foreground = false, roomId = null, order } = {}) {
  if (!ready()) return false;
  const now = Date.now();
  return Boolean(await redisClient.eval(`
    local old = redis.call('ZSCORE', KEYS[1], ARGV[1])
    local changed = not old or tonumber(old) <= tonumber(ARGV[2])
      or redis.call('HGET', KEYS[2], 'foreground') ~= ARGV[4]
      or redis.call('HGET', KEYS[2], 'roomId') ~= ARGV[5]
    redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
    redis.call('HSET', KEYS[2], 'userId', ARGV[6], 'foreground', ARGV[4], 'roomId', ARGV[5])
    if ARGV[8] ~= '' then redis.call('HSET', KEYS[2], 'activityBarrier', ARGV[8]) end
    redis.call('SADD', KEYS[3], ARGV[7])
    redis.call('SADD', KEYS[4], ARGV[6])
    return changed and 1 or 0
  `, {
    keys: [LEASES, socketKey(socketId), `user:${userId}:sockets`, 'online_users'],
    arguments: [memberKey(userId, socketId), String(now), String(now + LEASE_MS), foreground ? '1' : '0', roomId || '', userId, socketId, Number.isSafeInteger(order) ? String(order) : ''],
  }));
}

async function socketConnected(userId, socketId) {
  await renewSocket(userId, socketId);
  return ready() ? redisClient.sCard(`user:${userId}:sockets`) : 1;
}
async function userDisconnected(userId) {
  if (!ready()) return;
  await redisClient.eval("if redis.call('SCARD', KEYS[1]) == 0 then redis.call('SREM', KEYS[2], ARGV[1]) end; return 1", {
    keys: [`user:${userId}:sockets`, 'online_users'], arguments: [userId],
  });
}

async function userJoinedRoom(userId, roomId, socketId = `legacy:${userId}`) {
  if (!ready()) return;
  await redisClient.multi()
    .sAdd(roomUserSocketsKey(roomId, userId), socketId)
    .sAdd(socketRoomsKey(socketId), roomId)
    .sAdd(userRoomsKey(userId), roomId)
    .sAdd(`room:${roomId}:online`, userId).exec();
}
async function userLeftRoom(userId, roomId, socketId = `legacy:${userId}`, expiredAt = null) {
  if (!ready()) return false;
  return Boolean(await redisClient.eval(`
    local deadline = redis.call('ZSCORE', KEYS[7], ARGV[5])
    if ARGV[4] ~= '' and deadline and tonumber(deadline) > tonumber(ARGV[4]) then return 0 end
    redis.call('SREM', KEYS[1], ARGV[1]); redis.call('SREM', KEYS[2], ARGV[2])
    if redis.call('HGET', KEYS[5], 'roomId') == ARGV[2] then redis.call('HSET', KEYS[5], 'roomId', '') end
    if redis.call('SCARD', KEYS[1]) > 0 then return 0 end
    redis.call('DEL', KEYS[1], KEYS[6]); redis.call('SREM', KEYS[3], ARGV[2]); redis.call('SREM', KEYS[4], ARGV[3]); return 1
  `, {
    keys: [roomUserSocketsKey(roomId, userId), socketRoomsKey(socketId), userRoomsKey(userId), `room:${roomId}:online`, socketKey(socketId), `typing:${roomId}:${userId}`, LEASES],
    arguments: [socketId, roomId, userId, expiredAt === null ? '' : String(expiredAt), memberKey(userId, socketId)],
  }));
}
async function revokeUserRoom(userId, roomId) {
  if (!ready()) return;
  await activity.clearRoomUser(roomId, userId);
  await redisClient.eval(`
    local sockets = redis.call('SMEMBERS', KEYS[1])
    for _, id in ipairs(sockets) do
      redis.call('SREM', 'socket:' .. id .. ':rooms', ARGV[1])
      local meta = 'presence:socket:' .. id
      if redis.call('HGET', meta, 'roomId') == ARGV[1] then redis.call('HSET', meta, 'roomId', '') end
    end
    redis.call('DEL', KEYS[1], KEYS[4]); redis.call('SREM', KEYS[2], ARGV[1]); redis.call('SREM', KEYS[3], ARGV[2]); return 1
  `, {
    keys: [roomUserSocketsKey(roomId, userId), userRoomsKey(userId), `room:${roomId}:online`, `typing:${roomId}:${userId}`],
    arguments: [roomId, userId],
  });
}

// Compare the deadline inside the same Lua transaction as removal. A heartbeat
// racing the sweep wins if it has already renewed this device's lease.
async function removeSocket(userId, socketId, expiredAt = null) {
  if (!ready()) return [];
  const deadline = expiredAt === null ? null : await redisClient.zScore(LEASES, memberKey(userId, socketId));
  if (deadline !== null && Number(deadline) > expiredAt) return [];
  const activityRooms = [];
  const rooms = await redisClient.eval(`
    local deadline = redis.call('ZSCORE', KEYS[1], ARGV[1])
    if ARGV[4] ~= '' and deadline and tonumber(deadline) > tonumber(ARGV[4]) then return {} end
    local rooms = redis.call('SMEMBERS', KEYS[3])
    for _, room in ipairs(rooms) do
      local members = 'room:' .. room .. ':user:' .. ARGV[2] .. ':sockets'
      redis.call('SREM', members, ARGV[3])
      if redis.call('SCARD', members) == 0 then
        redis.call('DEL', members, 'typing:' .. room .. ':' .. ARGV[2])
        redis.call('SREM', 'room:' .. room .. ':online', ARGV[2])
        redis.call('SREM', KEYS[5], room)
      end
    end
    redis.call('DEL', KEYS[2], KEYS[3]); redis.call('ZREM', KEYS[1], ARGV[1])
    redis.call('SREM', KEYS[4], ARGV[3])
    if redis.call('SCARD', KEYS[4]) == 0 then redis.call('SREM', KEYS[6], ARGV[2]) end
    return rooms
  `, {
    keys: [LEASES, socketKey(socketId), socketRoomsKey(socketId), `user:${userId}:sockets`, userRoomsKey(userId), 'online_users'],
    arguments: [memberKey(userId, socketId), userId, socketId, expiredAt === null ? '' : String(expiredAt)],
  });
  // The lease is gone before clearing activity, so delayed starts cannot revive it.
  if (!await redisClient.zScore(LEASES, memberKey(userId, socketId))) activityRooms.push(...await activity.clearSocket(userId, socketId));
  return [...new Set([...rooms, ...activityRooms])];
}
async function cleanupSocketFromRooms(userId, socketId) { return removeSocket(userId, socketId); }
async function socketDisconnected(userId, socketId) {
  await removeSocket(userId, socketId);
  return ready() ? redisClient.sCard(`user:${userId}:sockets`) : 0;
}
async function cleanupUserFromRooms(userId) {
  if (!ready()) return [];
  const rooms = await redisClient.sMembers(userRoomsKey(userId));
  for (const room of rooms) await revokeUserRoom(userId, room);
  return rooms;
}

async function devicesForUsers(userIds, now = Date.now()) {
  const devices = new Map(userIds.map(id => [id, []]));
  if (!userIds.length) return devices;
  const indexes = redisClient.multi();
  for (const id of userIds) indexes.sMembers(`user:${id}:sockets`);
  const groups = await indexes.exec();
  const entries = groups.flatMap((ids, index) => ids.map(id => ({ id, userId: userIds[index] })));
  if (!entries.length) return devices;
  const batch = redisClient.multi();
  for (const { id, userId } of entries) batch.zScore(LEASES, memberKey(userId, id)).hGetAll(socketKey(id));
  const results = await batch.exec();
  entries.forEach(({ id, userId }, index) => {
    if (Number(results[index * 2]) > now && results[index * 2 + 1]?.userId === userId) devices.get(userId).push({ id, ...results[index * 2 + 1] });
  });
  return devices;
}
async function liveDevices(userId, now) { return (await devicesForUsers([userId], now)).get(userId); }
async function isUserOnline(userId) { return ready() && (await liveDevices(userId)).length > 0; }
async function isViewingRoom(userId, roomId) {
  return ready() && (await liveDevices(userId)).some(device => device.foreground === '1' && device.roomId === roomId);
}
async function getOnlineUsers() {
  if (!ready()) return [];
  const ids = await redisClient.sMembers('online_users');
  return (await Promise.all(ids.map(async id => await isUserOnline(id) ? id : null))).filter(Boolean);
}
async function getRoomOnlineUsers(roomId) {
  return roomDeviceUsers(roomId, false);
}
async function getRoomViewingUsers(roomId) {
  return roomDeviceUsers(roomId, true);
}
async function roomDeviceUsers(roomId, viewingOnly) {
  if (!ready()) return [];
  const ids = await redisClient.sMembers(`room:${roomId}:online`);
  if (!ids.length) return [];
  const devices = await devicesForUsers(ids);
  const batch = redisClient.multi();
  for (const id of ids) batch.sMembers(roomUserSocketsKey(roomId, id));
  const subscriptions = await batch.exec();
  return ids.filter((id, index) => {
    const subscribed = new Set(subscriptions[index]);
    return devices.get(id).some(device => subscribed.has(device.id) && (!viewingOnly || device.foreground === '1' && device.roomId === roomId));
  });
}
async function getTypingUsers(roomId) {
  return (await activity.snapshot(roomId)).filter(entry => entry.kind === 'typing').map(entry => entry.userId);
}
async function setTyping(roomId, userId, socketId, order) { return activity.update(roomId, userId, socketId, 'typing', true, order); }
async function clearTyping(roomId, userId) { await activity.clearRoomUser(roomId, userId); }

const unavailable = roomId => ({ roomId, available: false, onlineUserIds: [], viewingUserIds: [], typingUserIds: [], recordingUserIds: [], activity: [], checkedAt: Date.now() });
async function getRoomPresence(roomId, db = { query }) {
  if (!ready()) return unavailable(roomId);
  try {
    const members = await db.query('SELECT user_id FROM room_members WHERE room_id = $1', [roomId]);
    const onlineUserIds = [];
    const viewingUserIds = [];
    const now = Date.now();
    const byUser = await devicesForUsers(members.rows.map(member => member.user_id), now);
    for (const { user_id: id } of members.rows) {
      const devices = byUser.get(id);
      if (devices.length) onlineUserIds.push(id);
      if (devices.some(device => device.foreground === '1' && device.roomId === roomId)) viewingUserIds.push(id);
    }
    const currentActivity = await activity.readSnapshot(roomId, now);
    const entries = currentActivity.activity.filter(entry => onlineUserIds.includes(entry.userId));
    const typingUserIds = entries.filter(entry => entry.kind === 'typing').map(entry => entry.userId);
    const recordingUserIds = entries.filter(entry => entry.kind === 'recording').map(entry => entry.userId);
    return { roomId, available: true, onlineUserIds, viewingUserIds, typingUserIds, recordingUserIds, activity: entries, activityVersion: currentActivity.version, memberIds: members.rows.map(member => member.user_id), checkedAt: now };
  } catch (error) {
    console.error('Could not read room presence', { message: error.message });
    return unavailable(roomId);
  }
}
function filterPresence(snapshot, viewerId, pairs = []) {
  const hidden = new Set(pairs.flatMap(pair => pair.blocker_id === viewerId ? [pair.blocked_id] : pair.blocked_id === viewerId ? [pair.blocker_id] : []));
  const { memberIds, ...payload } = snapshot;
  for (const key of ['onlineUserIds', 'viewingUserIds', 'typingUserIds', 'recordingUserIds']) payload[key] = (payload[key] || []).filter(id => !hidden.has(id));
  payload.activity = (payload.activity || []).filter(entry => !hidden.has(entry.userId));
  payload.hiddenUserIds = [...hidden];
  return payload;
}
async function publishRoomPresence(io, roomId, db = { query }, actorId = null) {
  const adapter = io.of?.('/').adapter;
  const snapshot = await getRoomPresence(roomId, db);
  if (adapter?.pubClient && !adapter.pubClient.isReady) {
    (io.local || io).to(roomId).emit('room-presence', unavailable(roomId));
    return;
  }
  // fetchSockets supplies the intersection of room subscription and recipient
  // identity, including devices on other instances. Never use a union of rooms.
  if (!io.in) { io.to(roomId).emit('room-presence', unavailable(roomId)); return; }
  const subscribers = await io.in(roomId).fetchSockets();
  const members = new Set(snapshot.memberIds || []);
  if (!snapshot.available) {
    io.to(roomId).emit('room-presence', unavailable(roomId));
    return;
  }
  const pairs = await db.query('SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ANY($1::uuid[]) AND blocked_id = ANY($1::uuid[])', [[...members]]);
  const recipients = new Map();
  for (const socket of subscribers) {
    const id = socket.data?.userId;
    if (!members.has(id)) continue;
    if (!recipients.has(id)) recipients.set(id, []);
    recipients.get(id).push(socket.id);
  }
  for (const [id, socketIds] of recipients) {
    const payload = filterPresence(snapshot, id, pairs.rows);
    const privacy = await db.query(`SELECT u.id,privacy_allowed(u.id,$2,'online') AS online,
      privacy_allowed(u.id,$2,'last_seen') AS last_seen,u.last_active_at
      FROM users u WHERE u.id=ANY($1::uuid[])`, [[...members],id]);
    const concealed = new Set(privacy.rows.filter(row=>!row.online).map(row=>row.id));
    payload.onlineUserIds=payload.onlineUserIds.filter(user=>!concealed.has(user));
    payload.viewingUserIds=payload.viewingUserIds.filter(user=>!concealed.has(user));
    payload.hiddenUserIds=[...new Set([...payload.hiddenUserIds,...concealed])];
    payload.lastSeen=Object.fromEntries(privacy.rows.filter(row=>row.last_seen&&row.last_active_at).map(row=>[row.id,row.last_active_at]));
    const target = io.to(socketIds);
    target.emit('room-presence', payload);
    target.emit('room-typing', payload);
    if (actorId) {
      for (const kind of ['typing', 'recording']) {
        const entry = payload.activity.find(item => item.userId === actorId && item.kind === kind);
        // Blocked actors produce neither positive nor negative private activity.
        if (payload.hiddenUserIds.includes(actorId)) continue;
        target.emit(entry ? (kind === 'typing' ? 'typing' : 'start-recording') : (kind === 'typing' ? 'stop-typing' : 'stop-recording'), { roomId, userId: actorId, ttlMs: entry?.ttlMs || 0, activityVersion: payload.activityVersion });
      }
    }
  }
}
async function notifyPrivacyChanged(io, userId, otherId) {
  if (!io) return;
  const blocked = await query('SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [userId, otherId]);
  const hidden = blocked.rows.length > 0;
  io.to(`user:${userId}`).emit('privacy:changed', { userId: otherId, hidden });
  io.to(`user:${otherId}`).emit('privacy:changed', { userId, hidden });
  const shared = await query('SELECT mine.room_id FROM room_members mine JOIN room_members theirs ON theirs.room_id = mine.room_id WHERE mine.user_id = $1 AND theirs.user_id = $2', [userId, otherId]);
  for (const { room_id } of shared.rows) await publishRoomPresence(io, room_id);
}
async function publishUserPresence(io, userId) {
  try {
    const rooms = await query('SELECT room_id FROM room_members WHERE user_id = $1', [userId]);
    for (const { room_id: id } of rooms.rows) await publishRoomPresence(io, id);
  } catch (error) {
    console.error('Could not publish user presence', { message: error.message });
    (io.local || io).emit?.('presence:unavailable');
  }
}

async function sweepStaleSockets(now = Date.now()) {
  if (!ready()) return { userIds: [], roomIds: [] };
  const expired = await redisClient.zRangeByScore(LEASES, 0, now, { LIMIT: { offset: 0, count: 500 } });
  const users = new Set(); const rooms = new Set();
  for (const member of expired) {
    const separator = member.indexOf(':');
    const userId = member.slice(0, separator); const id = member.slice(separator + 1);
    for (const room of await removeSocket(userId, id, now)) rooms.add(room);
    users.add(userId);
  }
  return { userIds: [...users], roomIds: [...rooms] };
}
async function sweepStaleUsers() { return (await sweepStaleSockets()).userIds; }

// Reconcile indexes left by older servers or partial key loss. SCAN is
// incremental and each removal rechecks its lease atomically.
async function reconcilePresenceIndexes() {
  if (!ready()) return;
  for (const key of await scanKeys('user:*:sockets')) {
    const userId = key.split(':')[1];
    for (const id of await redisClient.sMembers(key)) {
      if (!await redisClient.zScore(LEASES, memberKey(userId, id))) await removeSocket(userId, id, Date.now());
    }
  }
  for (const key of await scanKeys('room:*:user:*:sockets')) {
    const [, roomId, , userId] = key.split(':');
    for (const id of await redisClient.sMembers(key)) await userLeftRoom(userId, roomId, id, Date.now());
  }
  for (const key of await scanKeys('presence:socket:*')) {
    const id = key.slice('presence:socket:'.length);
    const userId = await redisClient.hGet(key, 'userId');
    if (userId && !await redisClient.zScore(LEASES, memberKey(userId, id))) await removeSocket(userId, id, Date.now());
  }
  for (const key of await scanKeys('room:*:online')) {
    const roomId = key.split(':')[1];
    for (const userId of await redisClient.sMembers(key)) {
      await redisClient.eval(`
        if redis.call('SCARD', KEYS[1]) == 0 then
          redis.call('SREM', KEYS[2], ARGV[1]); redis.call('SREM', KEYS[3], ARGV[2])
        end; return 1
      `, { keys: [roomUserSocketsKey(roomId, userId), key, userRoomsKey(userId)], arguments: [userId, roomId] });
    }
  }
  for (const key of await scanKeys('user:*:rooms')) {
    const userId = key.split(':')[1];
    for (const roomId of await redisClient.sMembers(key)) {
      await redisClient.eval(`
        if redis.call('SCARD', KEYS[1]) == 0 then
          redis.call('SREM', KEYS[2], ARGV[1]); redis.call('SREM', KEYS[3], ARGV[2])
        end; return 1
      `, { keys: [roomUserSocketsKey(roomId, userId), key, `room:${roomId}:online`], arguments: [roomId, userId] });
    }
  }
  for (const userId of await redisClient.sMembers('online_users')) await userDisconnected(userId);
}
const sweeps = new Map();
function startHeartbeatSweep(io) {
  if (sweeps.has(io)) return;
  let running = false; let lastReconciled = 0;
  const run = async () => {
    if (running || !ready()) return;
    running = true;
    try {
      if (Date.now() - lastReconciled > 60000) { await reconcilePresenceIndexes(); lastReconciled = Date.now(); }
      const { userIds, roomIds } = await sweepStaleSockets();
      roomIds.push(...await activity.sweepExpired());
      for (const user of userIds) await publishUserPresence(io, user);
      for (const room of roomIds) await publishRoomPresence(io, room);
    } catch (error) { console.error('Presence heartbeat sweep failed', { message: error.message }); }
    finally { running = false; }
  };
  const timer = setInterval(() => trackCleanup(run()), 10000);
  timer.unref?.();
  sweeps.set(io, timer);
}
function stopHeartbeatSweep(io) {
  if (io) { clearInterval(sweeps.get(io)); sweeps.delete(io); }
  else { for (const timer of sweeps.values()) clearInterval(timer); sweeps.clear(); }
}
module.exports = {
  userDisconnected, socketConnected, socketDisconnected, renewSocket,
  isUserOnline, isViewingRoom, getOnlineUsers, userJoinedRoom, userLeftRoom,
  getRoomOnlineUsers, getRoomViewingUsers, revokeUserRoom, cleanupSocketFromRooms, cleanupUserFromRooms,
  setTyping, clearTyping, getTypingUsers, getRoomPresence, notifyPrivacyChanged, filterPresence,
  publishRoomPresence, publishUserPresence, sweepStaleUsers, sweepStaleSockets,
  reconcilePresenceIndexes, startHeartbeatSweep, stopHeartbeatSweep,
  trackCleanup, drainCleanup,
};
