const { isRedisReady, safe } = require("../config/redis");
const TTL_MS = 5000;
const kinds = ["typing", "recording"];
const stateKey = (room, user, kind) => `activity:${room}:${user}:${kind}`;
const localRooms = new Map();
const localOrders = new Map();
let localVersion = 0;
const useSharedRedis = () =>
  process.env.SOCKET_REDIS_ADAPTER === "true" && isRedisReady();

function updateLocal(roomId, userId, socketId, kind, active) {
  let room = localRooms.get(roomId);
  if (!room) {
    room = new Map();
    localRooms.set(roomId, room);
  }
  let user = room.get(userId);
  if (!user) {
    user = new Map();
    room.set(userId, user);
  }
  let sockets = user.get(kind);
  if (!sockets) {
    sockets = new Map();
    user.set(kind, sockets);
  }
  if (active) sockets.set(socketId, Date.now() + TTL_MS);
  else sockets.delete(socketId);
  if (sockets.size === 0) user.delete(kind);
  if (user.size === 0) room.delete(userId);
  if (room.size === 0) localRooms.delete(roomId);
  localVersion += 1;
  return true;
}

function readLocalSnapshot(roomId, now = Date.now()) {
  const room = localRooms.get(roomId);
  const activity = [];
  if (!room) return { activity, version: localVersion };
  for (const [userId, user] of room) {
    for (const [kind, sockets] of user) {
      let expiresAt = 0;
      for (const [socketId, expiry] of sockets) {
        if (expiry <= now) sockets.delete(socketId);
        else expiresAt = Math.max(expiresAt, expiry);
      }
      if (expiresAt > now)
        activity.push({ userId, kind, ttlMs: Math.min(TTL_MS, expiresAt - now) });
      if (sockets.size === 0) user.delete(kind);
    }
    if (user.size === 0) room.delete(userId);
  }
  if (room.size === 0) localRooms.delete(roomId);
  return { activity, version: localVersion };
}

function clearLocalSocket(userId, socketId) {
  const affected = [];
  for (const [roomId, room] of localRooms) {
    const user = room.get(userId);
    if (!user) continue;
    let changed = false;
    for (const sockets of user.values())
      changed = sockets.delete(socketId) || changed;
    for (const [kind, sockets] of user)
      if (sockets.size === 0) user.delete(kind);
    if (user.size === 0) room.delete(userId);
    if (changed) {
      affected.push(roomId);
      localVersion += 1;
    }
    if (room.size === 0) localRooms.delete(roomId);
  }
  for (const key of localOrders.keys())
    if (key.endsWith(`:${socketId}`)) localOrders.delete(key);
  return affected;
}

function clearLocalRoomUser(roomId, userId) {
  if (localRooms.get(roomId)?.delete(userId)) localVersion += 1;
  if (localRooms.get(roomId)?.size === 0) localRooms.delete(roomId);
}

// Socket event order is assigned before asynchronous authorization. A delayed
// start cannot overwrite a later stop, send, or navigation from the same device.
async function update(roomId, userId, socketId, kind, active, order) {
  if (!kinds.includes(kind)) throw new Error("Invalid conversation activity");
  const orderKey = `${roomId}:${socketId}`;
  const previousOrder = localOrders.get(orderKey);
  if (
    Number.isSafeInteger(order) &&
    Number.isSafeInteger(previousOrder) &&
    order < previousOrder
  )
    return false;
  if (Number.isSafeInteger(order)) localOrders.set(orderKey, order);
  if (!useSharedRedis())
    return updateLocal(roomId, userId, socketId, kind, active);
  const now = Date.now();
  const changed = await safe(
    (client) =>
      client.eval(
      `
    local previous = tonumber(redis.call('GET', KEYS[6]) or '-1')
    if tonumber(ARGV[8]) < previous then return 0 end
    if ARGV[5] == '1' then
      local lease = tonumber(redis.call('ZSCORE', KEYS[7], ARGV[1] .. ':' .. ARGV[2]) or '0')
      if lease <= tonumber(ARGV[6]) or redis.call('HGET', KEYS[8], 'foreground') ~= '1'
        or redis.call('HGET', KEYS[8], 'roomId') ~= ARGV[3]
        or tonumber(ARGV[8]) < tonumber(redis.call('HGET', KEYS[8], 'activityBarrier') or '0') then return 0 end
    end
    redis.call('SET', KEYS[6], ARGV[8], 'PX', 60000)
    if ARGV[5] == '1' then
      redis.call('ZREM', KEYS[2], ARGV[2])
      redis.call('ZADD', KEYS[1], ARGV[7], ARGV[2]); redis.call('PEXPIRE', KEYS[1], 6000)
      redis.call('SADD', KEYS[3], ARGV[1]); redis.call('SADD', KEYS[4], ARGV[3])
      redis.call('SREM', KEYS[5], ARGV[3] .. ':' .. ARGV[9])
      redis.call('SADD', KEYS[5], ARGV[3] .. ':' .. ARGV[4]); redis.call('PEXPIRE', KEYS[5], 60000)
    else
      redis.call('ZREM', KEYS[1], ARGV[2]); redis.call('SREM', KEYS[5], ARGV[3] .. ':' .. ARGV[4])
    end
    redis.call('INCR', KEYS[9]); return 1
  `,
        {
        keys: [
          stateKey(roomId, userId, kind),
          stateKey(roomId, userId, kind === "typing" ? "recording" : "typing"),
          `activity:${roomId}:users`,
          "activity:rooms",
          `socket:${socketId}:activity`,
          `activity:version:${roomId}:${socketId}`,
          "presence:leases",
          `presence:socket:${socketId}`,
          `activity:${roomId}:version`,
        ],
        arguments: [
          userId,
          socketId,
          roomId,
          kind,
          active ? "1" : "0",
          String(now),
          String(now + TTL_MS),
          String(order),
          kind === "typing" ? "recording" : "typing",
        ],
        },
      ),
    undefined,
  );
  if (changed === undefined || changed) {
    updateLocal(roomId, userId, socketId, kind, active);
    return true;
  }
  return false;
}

async function readSnapshot(roomId, now = Date.now()) {
  if (!useSharedRedis()) return readLocalSnapshot(roomId, now);
  const flat = await safe(
    (client) =>
      client.eval(
    `
    local result = {}; local changed = false; local users = redis.call('SMEMBERS', KEYS[1])
    for _, user in ipairs(users) do
      local found = false
      for _, kind in ipairs({'typing', 'recording'}) do
        local key = 'activity:' .. ARGV[1] .. ':' .. user .. ':' .. kind
        if redis.call('ZREMRANGEBYSCORE', key, '-inf', ARGV[2]) > 0 then changed = true end
        local entries = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES'); local expires = 0
        for index = 1, #entries, 2 do
          local id = entries[index]; local meta = 'presence:socket:' .. id
          local lease = tonumber(redis.call('ZSCORE', KEYS[2], user .. ':' .. id) or '0')
          if lease > tonumber(ARGV[2]) and redis.call('HGET', meta, 'foreground') == '1'
            and redis.call('HGET', meta, 'roomId') == ARGV[1] then
            expires = math.max(expires, tonumber(entries[index + 1]))
          else redis.call('ZREM', key, id); changed = true end
        end
        if expires > 0 then
          found = true; table.insert(result, user); table.insert(result, kind); table.insert(result, tostring(expires))
        end
      end
      if not found and redis.call('SREM', KEYS[1], user) > 0 then changed = true end
    end
    if redis.call('SCARD', KEYS[1]) == 0 then redis.call('SREM', KEYS[3], ARGV[1]) end
    if changed then redis.call('INCR', KEYS[4]) end
    table.insert(result, 1, tostring(redis.call('GET', KEYS[4]) or '0')); return result
  `,
        {
      keys: [
        `activity:${roomId}:users`,
        "presence:leases",
        "activity:rooms",
        `activity:${roomId}:version`,
      ],
      arguments: [roomId, String(now)],
        },
      ),
    null,
  );
  if (!flat) return readLocalSnapshot(roomId, now);
  const result = [];
  for (let index = 1; index < flat.length; index += 3)
    result.push({
      userId: flat[index],
      kind: flat[index + 1],
      ttlMs: Math.max(0, Math.min(TTL_MS, Number(flat[index + 2]) - now)),
    });
  return { activity: result, version: Number(flat[0]) || 0 };
}
async function snapshot(roomId, now) {
  return (await readSnapshot(roomId, now)).activity;
}
async function clearDevice(roomId, userId, socketId, order) {
  for (const kind of kinds)
    await update(roomId, userId, socketId, kind, false, order);
}
async function clearSocket(userId, socketId) {
  if (!useSharedRedis()) return clearLocalSocket(userId, socketId);
  const rooms = await safe(
    (client) =>
      client.eval(
    `
    if redis.call('ZSCORE', KEYS[1], ARGV[1] .. ':' .. ARGV[2]) then return {} end
    local entries = redis.call('SMEMBERS', KEYS[2]); local rooms = {}
    for _, entry in ipairs(entries) do
      local room, kind = string.match(entry, '^(.-):([^:]+)$')
      if room and kind then
        if redis.call('ZREM', 'activity:' .. room .. ':' .. ARGV[1] .. ':' .. kind, ARGV[2]) > 0 then redis.call('INCR', 'activity:' .. room .. ':version') end
        table.insert(rooms, room)
      end
    end
    redis.call('DEL', KEYS[2]); return rooms
  `,
        {
      keys: ["presence:leases", `socket:${socketId}:activity`],
      arguments: [userId, socketId],
        },
      ),
    null,
  );
  if (!rooms) return clearLocalSocket(userId, socketId);
  const localCleared = clearLocalSocket(userId, socketId);
  return [...new Set([...rooms, ...localCleared])];
}
async function clearRoomUser(roomId, userId) {
  if (!useSharedRedis()) return clearLocalRoomUser(roomId, userId);
  await safe(
    (client) =>
      client.eval(
    "redis.call('DEL', KEYS[1], KEYS[2]); redis.call('SREM', KEYS[3], ARGV[1]); return redis.call('INCR', KEYS[4])",
        {
      keys: [
        stateKey(roomId, userId, "typing"),
        stateKey(roomId, userId, "recording"),
        `activity:${roomId}:users`,
        `activity:${roomId}:version`,
      ],
      arguments: [userId],
        },
      ),
    undefined,
  );
  clearLocalRoomUser(roomId, userId);
}
async function sweepExpired() {
  if (!useSharedRedis()) {
    const rooms = [...localRooms.keys()];
    for (const roomId of rooms) readLocalSnapshot(roomId);
    return rooms;
  }
  const rooms = await safe((client) => client.sMembers("activity:rooms"), null);
  if (!rooms) return [];
  for (const roomId of rooms) await snapshot(roomId);
  return rooms;
}
module.exports = {
  update,
  snapshot,
  readSnapshot,
  clearDevice,
  clearSocket,
  clearRoomUser,
  sweepExpired,
  TTL_MS,
};
