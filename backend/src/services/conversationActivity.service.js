const { redisClient } = require('../config/redis');
const TTL_MS = 5000;
const kinds = ['typing', 'recording'];
const stateKey = (room, user, kind) => `activity:${room}:${user}:${kind}`;

// Socket event order is assigned before asynchronous authorization. A delayed
// start cannot overwrite a later stop, send, or navigation from the same device.
async function update(roomId, userId, socketId, kind, active, order) {
  if (!redisClient.isReady) return false;
  if (!kinds.includes(kind)) throw new Error('Invalid conversation activity');
  const now = Date.now();
  return Boolean(await redisClient.eval(`
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
  `, {
    keys: [stateKey(roomId, userId, kind), stateKey(roomId, userId, kind === 'typing' ? 'recording' : 'typing'), `activity:${roomId}:users`, 'activity:rooms', `socket:${socketId}:activity`, `activity:version:${roomId}:${socketId}`, 'presence:leases', `presence:socket:${socketId}`, `activity:${roomId}:version`],
    arguments: [userId, socketId, roomId, kind, active ? '1' : '0', String(now), String(now + TTL_MS), String(order), kind === 'typing' ? 'recording' : 'typing'],
  }));
}

async function readSnapshot(roomId, now = Date.now()) {
  if (!redisClient.isReady) return { activity: [], version: 0 };
  const flat = await redisClient.eval(`
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
  `, { keys: [`activity:${roomId}:users`, 'presence:leases', 'activity:rooms', `activity:${roomId}:version`], arguments: [roomId, String(now)] });
  const result = [];
  for (let index = 1; index < flat.length; index += 3) result.push({ userId: flat[index], kind: flat[index + 1], ttlMs: Math.max(0, Math.min(TTL_MS, Number(flat[index + 2]) - now)) });
  return { activity: result, version: Number(flat[0]) || 0 };
}
async function snapshot(roomId, now) { return (await readSnapshot(roomId, now)).activity; }
async function clearDevice(roomId, userId, socketId, order) {
  for (const kind of kinds) await update(roomId, userId, socketId, kind, false, order);
}
async function clearSocket(userId, socketId) {
  if (!redisClient.isReady) return [];
  const rooms = await redisClient.eval(`
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
  `, { keys: ['presence:leases', `socket:${socketId}:activity`], arguments: [userId, socketId] });
  return [...new Set(rooms)];
}
async function clearRoomUser(roomId, userId) {
  if (!redisClient.isReady) return;
  await redisClient.eval("redis.call('DEL', KEYS[1], KEYS[2]); redis.call('SREM', KEYS[3], ARGV[1]); return redis.call('INCR', KEYS[4])", { keys: [stateKey(roomId, userId, 'typing'), stateKey(roomId, userId, 'recording'), `activity:${roomId}:users`, `activity:${roomId}:version`], arguments: [userId] });
}
async function sweepExpired() {
  if (!redisClient.isReady) return [];
  const rooms = await redisClient.sMembers('activity:rooms');
  for (const roomId of rooms) await snapshot(roomId);
  return rooms;
}
module.exports = { update, snapshot, readSnapshot, clearDevice, clearSocket, clearRoomUser, sweepExpired, TTL_MS };
