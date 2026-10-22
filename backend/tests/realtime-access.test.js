'use strict';

// Real PostgreSQL, Redis adapter and two independently listening Socket.IO
// servers. A disposable database prevents this suite touching application data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { Client } = require('pg');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const { createAdapter } = require('@socket.io/redis-adapter');
const jwt = require('jsonwebtoken');
require('dotenv').config({ quiet: true });
const adminUrl = process.env.DATABASE_URL || 'postgres://app:app@127.0.0.1:5432/postgres';
const database = `conclave_security_${randomBytes(12).toString('hex')}`;
process.env.RATE_LIMIT_KEY_PREFIX = `${database}:rate-limit`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${database}`;
process.env.DATABASE_URL = databaseUrl.toString();
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET ||= 'security-test-access';
process.env.JWT_REFRESH_SECRET ||= 'security-test-refresh';
const { pool, query } = require('../src/config/db');
const { redisClient, connectRedis } = require('../src/config/redis');
const presence = require('../src/services/presence.service');
const app = require('../src/app');
const registerSockets = require('../src/sockets');
const { signAccessToken, signRefreshToken } = require('../src/services/token.service');
const servers = [];
const sockets = [];
const redisPeers = [];
const users = [];
const roomIds = [];
let admin;
let created = false;

async function request(path, token, method = 'GET', body) {
  const response = await fetch(`${servers[0].url}/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off(name, done); reject(new Error(`Timed out waiting for ${name}`)); }, 6000);
    function done(value) { clearTimeout(timeout); resolve(value); }
    socket.once(name, done);
  });
}
async function open(token, instance = 0) {
  const socket = connect(servers[instance].url, { auth: { token }, transports: ['websocket'], reconnection: false, autoConnect: false });
  sockets.push(socket);
  const ready = event(socket, 'connect');
  socket.connect();
  await ready;
  socket.testId = socket.id;
  return socket;
}
async function ack(socket, name, payload) {
  return socket.timeout(6000).emitWithAck(name, payload);
}
async function account() {
  const id = randomUUID();
  await query('INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
    [id, `${id}@security.test`, 'unused', 'Security fixture']);
  users.push(id);
  return session(id);
}
async function session(userId) {
  const sessionId = randomUUID();
  await query("INSERT INTO auth_sessions (id,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '7 days')", [sessionId, userId]);
  const user = { id: userId, sessionId };
  const token = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  await query("INSERT INTO refresh_tokens (user_id,token_hash,expires_at,session_id) VALUES ($1,$2,NOW()+INTERVAL '7 days',$3)",
    [userId, createHash('sha256').update(refreshToken).digest('hex'), sessionId]);
  return { userId, sessionId, token, refreshToken };
}
async function room(owner, member, type = 'group') {
  const id = randomUUID();
  await query("INSERT INTO rooms (id,name,type,created_by,slug) VALUES ($1,'Security fixture',$4,$2,$3)", [id, owner.userId, id, type]);
  await query("INSERT INTO room_members (room_id,user_id,role) VALUES ($1,$2,'admin'),($1,$3,'member')", [id, owner.userId, member.userId]);
  roomIds.push(id);
  return id;
}

async function startInstance(port = 0) {
  const http = require('node:http').createServer(app);
  const io = new Server(http);
  const pub = redisClient.duplicate(); const sub = redisClient.duplicate();
  await Promise.all([pub.connect(), sub.connect()]);
  redisPeers.push(pub, sub);
  io.adapter(createAdapter(pub, sub, { key: database, requestsTimeout: 3000 }));
  registerSockets(io);
  await new Promise(resolve => http.listen(port, '127.0.0.1', resolve));
  const instance = { io, http, url: `http://127.0.0.1:${http.address().port}` };
  servers.push(instance);
  return instance;
}

test.before(async () => {
  admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  created = true;
  require('node:child_process').execFileSync(process.execPath, ['database/migrate.js'], {
    cwd: require('node:path').join(__dirname, '..'), env: process.env, stdio: 'pipe',
  });
  await connectRedis();
  for (let index = 0; index < 2; index++) {
    await startInstance();
  }
  app.set('io', servers[0].io);
  // Redis subscription registration is asynchronous after adapter creation.
  for (let attempt = 0; attempt < 50 && await servers[0].io.of('/').adapter.serverCount() !== 2; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await servers[0].io.of('/').adapter.serverCount(), 2);
});
test.after(async () => {
  for (const socket of sockets) socket.disconnect();
  // Let async disconnect presence handlers finish before closing Redis peers.
  await new Promise(resolve => setTimeout(resolve, 150));
  for (const { io } of servers) await new Promise(resolve => io.close(resolve));
  presence.stopHeartbeatSweep();
  await presence.drainCleanup();
  for (const peer of redisPeers) if (peer.isOpen) await peer.quit();
  // Only remove this suite's UUID-scoped presence records; never FLUSHDB.
  if (redisClient.isOpen) {
    const keys = [];
    for await (const key of redisClient.scanIterator({ MATCH: '*', COUNT: 100 })) {
      if (key.startsWith(`${database}:`) || [...users, ...roomIds, ...sockets.map(socket => socket.testId).filter(Boolean)].some(id => key.includes(id))) keys.push(key);
    }
    if (keys.length) await redisClient.del(keys);
    for (const id of users) await redisClient.sRem('online_users', id);
    if (roomIds.length) await redisClient.sRem('activity:rooms', roomIds);
    await redisClient.quit();
  }
  await pool.end();
  if (admin) {
    if (created) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const active = await admin.query('SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [database]);
        if (!active.rows[0].count) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
      await admin.query(`DROP DATABASE ${database}`);
    }
    await admin.end();
  }
});

test('removal evicts every device across two servers and cleans presence and typing', async () => {
  const owner = await account();
  const member = await account();
  const otherDevice = await session(member.userId);
  const id = await room(owner, member);
  const remaining = await open(owner.token);
  const a = await open(member.token);
  const b = await open(otherDevice.token, 1);
  for (const socket of [remaining, a, b]) {
    socket.testId = socket.id;
    assert.equal((await ack(socket, 'join-room', { roomId: id })).ok, true);
  }
  await ack(b, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  const typing = event(remaining, 'typing');
  b.emit('typing', { roomId: id });
  await typing;
  assert.ok((await presence.getTypingUsers(id)).includes(member.userId));
  const changeA = event(a, 'room:members');
  const changeB = event(b, 'room:members');
  const result = await request(`/rooms/${id}/members/${member.userId}`, owner.token, 'DELETE');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await changeA).action, 'removed');
  assert.equal((await changeB).action, 'removed');
  for (const server of servers) {
    const subscribers = await server.io.in(id).fetchSockets();
    assert.ok(subscribers.every(socket => socket.data.userId !== member.userId));
  }
  assert.deepEqual(await presence.getRoomOnlineUsers(id), [owner.userId]);
  assert.deepEqual(await presence.getTypingUsers(id), []);
  for (const socket of [a, b]) {
    assert.equal(await redisClient.sIsMember(`socket:${socket.id}:rooms`, id), false);
    assert.equal((await ack(socket, 'join-room', { roomId: id })).status, 403);
    assert.equal((await ack(socket, 'typing', { roomId: id })).status, 403);
    assert.equal((await ack(socket, 'send-message', { roomId: id, content: 'Forbidden' })).status, 404);
  }
  assert.equal((await request(`/rooms/${id}`, member.token)).status, 403);
  const leaked = [];
  const events = ['receive-message', 'message:updated', 'message:deleted', 'message:reaction', 'message:pinned', 'poll:updated', 'typing', 'room:updated'];
  for (const socket of [a, b]) for (const name of events) socket.on(name, value => leaked.push(value));
  for (const { io } of servers) {
    for (const name of events) {
      const received = event(remaining, name);
      io.to(id).emit(name, { roomId: id, marker: 'authorized only' });
      await received;
    }
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(leaked, []);
});

test('leaving a room evicts another connected device too', async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const a = await open(member.token);
  const b = await open(member.token, 1);
  await Promise.all([a, b].map(socket => ack(socket, 'join-room', { roomId: id })));
  const changed = event(b, 'room:members');
  assert.equal((await request(`/rooms/${id}/members/${member.userId}`, member.token, 'DELETE')).status, 200);
  assert.equal((await changed).action, 'left');
  assert.equal((await servers[0].io.in(id).fetchSockets()).length, 0);
});

test('an in-flight join cannot restore membership while removal commits', async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const socket = await open(member.token, 1);
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [id]);
    const joining = ack(socket, 'join-room', { roomId: id });
    await new Promise(resolve => setTimeout(resolve, 50));
    const removing = request(`/rooms/${id}/members/${member.userId}`, owner.token, 'DELETE');
    await blocker.query('COMMIT');
    const [join, removal] = await Promise.all([joining, removing]);
    assert.ok(join.ok || join.status === 403);
    assert.equal(removal.status, 200);
    assert.equal((await servers[0].io.in(id).fetchSockets()).length, 0);
    assert.deepEqual(await presence.getRoomOnlineUsers(id), []);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
});

test('logout revokes rotated tokens and connected sockets across servers, preserving other sessions', async () => {
  const original = await account();
  const independent = await session(original.userId);
  const rotated = await request('/auth/refresh', null, 'POST', { refreshToken: original.refreshToken });
  assert.equal(rotated.status, 200);
  assert.equal(jwt.decode(rotated.body.data.accessToken).sid, original.sessionId);
  assert.equal((await request('/auth/refresh', null, 'POST', { refreshToken: original.refreshToken })).status, 401);
  const a = await open(original.token);
  const b = await open(rotated.body.data.accessToken, 1);
  const survivor = await open(independent.token, 1);
  const disconnected = [event(a, 'disconnect'), event(b, 'disconnect')];
  // Even the pre-rotation refresh token revokes the stable session.
  assert.equal((await request('/auth/logout', null, 'POST', { refreshToken: original.refreshToken })).status, 200);
  await Promise.all(disconnected);
  assert.equal(survivor.connected, true);
  assert.equal((await request('/users/me', original.token)).status, 401);
  assert.equal((await request('/users/me', rotated.body.data.accessToken)).status, 401);
  assert.equal((await request('/auth/refresh', null, 'POST', { refreshToken: rotated.body.data.refreshToken })).status, 401);
  assert.equal((await request('/users/me', independent.token)).status, 200);
  const rejected = connect(servers[1].url, { auth: { token: original.token }, reconnection: false, autoConnect: false });
  sockets.push(rejected);
  const denied = event(rejected, 'connect_error');
  rejected.connect();
  assert.equal((await denied).data.code, 'SESSION_REVOKED');
});

test('idle sockets expire and can reconnect after refreshing an active session', async () => {
  const member = await account();
  const short = jwt.sign({ sub: member.userId, sid: member.sessionId }, process.env.JWT_ACCESS_SECRET, { expiresIn: 2 });
  const socket = await open(short, 1);
  const expired = event(socket, 'session:expired');
  const disconnected = event(socket, 'disconnect');
  assert.equal((await expired).sessionId, member.sessionId);
  await disconnected;
  const renewed = await request('/auth/refresh', null, 'POST', { refreshToken: member.refreshToken });
  assert.equal(renewed.status, 200);
  const next = await open(renewed.body.data.accessToken, 1);
  assert.equal(next.connected, true);
});

test('tokens without a durable session and expired database sessions are rejected', async () => {
  const member = await account();
  const legacy = jwt.sign({ sub: member.userId }, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
  assert.equal((await request('/users/me', legacy)).status, 401);
  await query("UPDATE auth_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [member.sessionId]);
  assert.equal((await request('/users/me', member.token)).status, 401);
  assert.equal((await request('/auth/refresh', null, 'POST', { refreshToken: member.refreshToken })).status, 401);
});

test('a peer eviction failure rolls removal back and requests client resynchronization', async (t) => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const socket = await open(member.token);
  assert.equal((await ack(socket, 'join-room', { roomId: id })).ok, true);
  const namespace = servers[1].io.of('/');
  const name = 'security:revoke-access';
  const original = namespace.listeners(name);
  namespace.removeAllListeners(name);
  namespace.on(name, (_request, acknowledge) => acknowledge({ ok: false }));
  t.after(() => {
    namespace.removeAllListeners(name);
    for (const handler of original) namespace.on(name, handler);
  });
  const resync = event(socket, 'room:resync');
  const response = await request(`/rooms/${id}/members/${member.userId}`, owner.token, 'DELETE');
  assert.equal(response.status, 503);
  assert.equal((await resync).roomId, id);
  assert.equal((await query('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [id, member.userId])).rows.length, 1);
  assert.equal((await ack(socket, 'join-room', { roomId: id })).ok, true);
});

test('room presence distinguishes connected elsewhere, foreground viewing and typing', async () => {
  const owner = await account(); const member = await account(); const outsider = await account();
  const id = await room(owner, member);
  const watcher = await open(owner.token); const peer = await open(member.token, 1);
  await ack(watcher, 'join-room', { roomId: id });
  await ack(peer, 'heartbeat', { foreground: true, roomId: null, revision: 1 });
  let snapshot = await presence.getRoomPresence(id);
  assert.ok(snapshot.onlineUserIds.includes(member.userId));
  assert.ok(!snapshot.viewingUserIds.includes(member.userId));
  await ack(peer, 'join-room', { roomId: id });
  assert.ok(!(await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId), 'subscription is not foreground attention');
  await ack(peer, 'heartbeat', { foreground: true, roomId: id, revision: 2 });
  assert.ok((await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId));
  const typing = event(watcher, 'typing'); peer.emit('typing', { roomId: id }); await typing;
  assert.ok((await presence.getRoomPresence(id)).typingUserIds.includes(member.userId));
  await ack(peer, 'heartbeat', { foreground: false, roomId: null, revision: 3 });
  snapshot = await presence.getRoomPresence(id);
  assert.ok(snapshot.onlineUserIds.includes(member.userId));
  assert.ok(!snapshot.viewingUserIds.includes(member.userId));
  assert.ok(!snapshot.typingUserIds.includes(member.userId));
  // A delayed foreground packet cannot undo the newer background state.
  await ack(peer, 'heartbeat', { foreground: true, roomId: id, revision: 2 });
  assert.ok(!(await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId));
  await ack(peer, 'heartbeat', { foreground: true, roomId: id, revision: 4 });
  await ack(peer, 'typing', { roomId: id });
  assert.equal((await peer.timeout(6000).emitWithAck('heartbeat')).ok, true);
  assert.deepEqual((await presence.getRoomPresence(id)).typingUserIds, [], 'legacy heartbeat clears activity without claiming attention');
  const stranger = await open(outsider.token, 1);
  await ack(stranger, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  snapshot = await presence.getRoomPresence(id);
  assert.ok(!snapshot.onlineUserIds.includes(outsider.userId));
  assert.ok(!snapshot.viewingUserIds.includes(outsider.userId));
});

test('one healthy device cannot keep a sleeping device or its room indexes alive', async () => {
  const owner = await account(); const member = await account();
  const id = await room(owner, member);
  const sleeping = await open(member.token); const awake = await open(member.token, 1);
  await ack(sleeping, 'join-room', { roomId: id });
  await ack(sleeping, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  await ack(awake, 'heartbeat', { foreground: true, roomId: null, revision: 1 });
  await redisClient.zAdd('presence:leases', { score: Date.now() - 1, value: `${member.userId}:${sleeping.id}` });
  assert.equal(await presence.isUserOnline(member.userId), true);
  assert.ok(!(await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId));
  await presence.sweepStaleSockets();
  assert.equal(await redisClient.exists(`presence:socket:${sleeping.id}`), 0);
  assert.equal(await redisClient.sIsMember(`user:${member.userId}:sockets`, sleeping.id), false);
  assert.equal(await redisClient.sIsMember(`room:${id}:user:${member.userId}:sockets`, sleeping.id), false);
  assert.equal(await redisClient.exists(`socket:${sleeping.id}:rooms`), 0);
  assert.equal(await presence.isUserOnline(member.userId), true);
  await ack(sleeping, 'heartbeat', { foreground: true, roomId: id, revision: 2 });
  assert.ok((await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId), 'resuming restores the device and its room');
  assert.equal(await redisClient.sIsMember(`socket:${sleeping.id}:rooms`, id), true);
  assert.equal((await ack(sleeping, 'typing', { roomId: id })).data.accepted, true, 'typing resumes after a device lease expired');
  await ack(awake, 'join-room', { roomId: id });
  await ack(sleeping, 'leave-room', { roomId: id });
  assert.ok(!(await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId), 'a background subscription does not retain foreground attention');
  assert.equal(await presence.isUserOnline(member.userId), true);
});

test('sweep does not remove a device renewed after the expiry candidate was selected', async () => {
  const member = await account(); const socket = await open(member.token);
  await ack(socket, 'heartbeat', { foreground: true, roomId: null, revision: 1 });
  const oldDeadline = Date.now() - 1;
  await redisClient.zAdd('presence:leases', { score: oldDeadline, value: `${member.userId}:${socket.id}` });
  await presence.renewSocket(member.userId, socket.id, { foreground: true });
  await presence.sweepStaleSockets(oldDeadline + 1);
  assert.equal(await presence.isUserOnline(member.userId), true);
  assert.equal(await redisClient.exists(`presence:socket:${socket.id}`), 1);
});

test('orphaned indexes are pruned even when a reverse index or lease was lost', async () => {
  const owner = await account(); const member = await account(); const id = await room(owner, member);
  const dead = `crashed-${randomUUID()}`;
  await presence.socketConnected(member.userId, dead);
  await presence.userJoinedRoom(member.userId, id, dead);
  await redisClient.del(`socket:${dead}:rooms`);
  await redisClient.zRem('presence:leases', `${member.userId}:${dead}`);
  await redisClient.sAdd(`user:${member.userId}:rooms`, randomUUID());
  await presence.reconcilePresenceIndexes();
  assert.equal(await redisClient.exists(`presence:socket:${dead}`), 0);
  assert.equal(await redisClient.sIsMember(`room:${id}:online`, member.userId), false);
  assert.equal(await redisClient.exists(`user:${member.userId}:rooms`), 0);
  assert.equal(await presence.isUserOnline(member.userId), false);
});

test('Redis data loss and a presence connection outage recover from existing authenticated sockets', async () => {
  const owner = await account(); const member = await account(); const id = await room(owner, member);
  const socket = await open(member.token, 1);
  await ack(socket, 'join-room', { roomId: id });
  await ack(socket, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  // Delete only this fixture's records, simulating lost volatile Redis state.
  const keys = [];
  for await (const key of redisClient.scanIterator({ MATCH: '*', COUNT: 100 })) {
    if ([member.userId, id, socket.id].some(value => key.includes(value))) keys.push(key);
  }
  if (keys.length) await redisClient.del(keys);
  await redisClient.zRem('presence:leases', `${member.userId}:${socket.id}`);
  await redisClient.sRem('online_users', member.userId);
  assert.ok(!(await presence.getRoomPresence(id)).onlineUserIds.includes(member.userId));
  await ack(socket, 'heartbeat', { foreground: true, roomId: id, revision: 2 });
  assert.ok((await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId));
  assert.equal(await redisClient.sIsMember(`socket:${socket.id}:rooms`, id), true);
  const unavailable = event(socket, 'presence:unavailable');
  await redisClient.disconnect();
  await unavailable;
  assert.equal((await presence.getRoomPresence(id)).available, false);
  const resync = event(socket, 'presence:resync');
  await connectRedis(); await resync;
  await ack(socket, 'heartbeat', { foreground: true, roomId: id, revision: 3 });
  assert.equal((await presence.getRoomPresence(id)).available, true);
  assert.ok((await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId));
});

test('a database lookup outage yields unknown presence and recovers without inventing offline state', async () => {
  const owner = await account(); const member = await account(); const id = await room(owner, member);
  const socket = await open(member.token);
  await ack(socket, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  const failed = await presence.getRoomPresence(id, { query: async () => { throw new Error('Simulated database outage'); } });
  assert.equal(failed.available, false);
  assert.deepEqual(failed.onlineUserIds, []);
  const recovered = await presence.getRoomPresence(id);
  assert.equal(recovered.available, true);
  assert.ok(recovered.viewingUserIds.includes(member.userId));
});

test('an API server restart reconnects the client and removes the crashed socket lease', async () => {
  const owner = await account(); const member = await account(); const id = await room(owner, member);
  const server = await startInstance();
  const client = await open(member.token, servers.length - 1);
  await ack(client, 'join-room', { roomId: id });
  await ack(client, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  const oldId = client.id;
  // Simulate abrupt process loss: Redis receives no disconnect cleanup.
  const oldSocket = server.io.of('/').sockets.get(oldId);
  oldSocket.removeAllListeners('disconnect');
  client.io.reconnection(true);
  client.io.reconnectionDelay(100);
  client.io.reconnectionDelayMax(200);
  const reconnected = event(client, 'connect');
  oldSocket.conn.close();
  const port = server.http.address().port;
  await new Promise(resolve => server.io.close(resolve));
  await startInstance(port);
  await reconnected;
  assert.notEqual(client.id, oldId);
  await ack(client, 'join-room', { roomId: id });
  await ack(client, 'heartbeat', { foreground: true, roomId: id, revision: 2 });
  await redisClient.zAdd('presence:leases', { score: Date.now() - 1, value: `${member.userId}:${oldId}` });
  await presence.sweepStaleSockets();
  assert.equal(await redisClient.exists(`presence:socket:${oldId}`), 0);
  assert.ok((await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId));
});

test('typing and recording aggregate devices and expire both initial snapshots and device state', async () => {
  const owner = await account(); const member = await account(); const id = await room(owner, member);
  const observer = await open(owner.token); const a = await open(member.token); const b = await open(member.token, 1);
  for (const socket of [observer, a, b]) {
    await ack(socket, 'join-room', { roomId: id });
    await ack(socket, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  }
  assert.equal((await ack(a, 'typing', { roomId: id })).data.accepted, true);
  await ack(b, 'typing', { roomId: id });
  await ack(a, 'stop-typing', { roomId: id });
  assert.ok((await presence.getRoomPresence(id)).typingUserIds.includes(member.userId));
  await ack(a, 'start-recording', { roomId: id });
  let state = await presence.getRoomPresence(id);
  assert.ok(state.recordingUserIds.includes(member.userId));
  assert.ok(state.typingUserIds.includes(member.userId), 'another device is still typing');
  await ack(a, 'stop-recording', { roomId: id });
  assert.ok(!(await presence.getRoomPresence(id)).recordingUserIds.includes(member.userId));
  assert.ok((await presence.getRoomPresence(id)).typingUserIds.includes(member.userId));
  await ack(a, 'start-recording', { roomId: id });
  await ack(a, 'send-message', { roomId: id, content: 'Sent from device A' });
  state = await presence.getRoomPresence(id);
  assert.ok(!state.recordingUserIds.includes(member.userId));
  assert.ok(state.typingUserIds.includes(member.userId), 'sending on A must not stop B');
  await ack(b, 'heartbeat', { foreground: false, roomId: null, revision: 2 });
  assert.deepEqual((await presence.getRoomPresence(id)).typingUserIds, []);
  await ack(a, 'typing', { roomId: id });
  const activity = require('../src/services/conversationActivity.service');
  assert.deepEqual(await activity.snapshot(id, Date.now() + 6000), []);
});

test('delayed starts cannot overwrite a later stop and recording rejects background devices', async () => {
  const owner = await account(); const member = await account(); const id = await room(owner, member);
  const socket = await open(member.token);
  await ack(socket, 'join-room', { roomId: id });
  assert.equal((await ack(socket, 'start-recording', { roomId: id })).data.accepted, false);
  await ack(socket, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  const activity = require('../src/services/conversationActivity.service');
  const before = await activity.readSnapshot(id);
  await activity.update(id, member.userId, socket.id, 'typing', false, 1000);
  const stopped = await activity.readSnapshot(id);
  assert.ok(stopped.version > before.version);
  assert.equal(await activity.update(id, member.userId, socket.id, 'typing', true, 999), false);
  assert.equal((await activity.readSnapshot(id)).version, stopped.version);
  assert.deepEqual(await activity.snapshot(id), []);
});

test('activity is private to members and symmetric blocks hide presence, typing and recording in shared groups', async () => {
  const owner = await account(); const member = await account(); const outsider = await account(); const id = await room(owner, member);
  const a = await open(owner.token); const b = await open(member.token, 1); const stranger = await open(outsider.token, 1);
  for (const socket of [a, b]) { await ack(socket, 'join-room', { roomId: id }); await ack(socket, 'heartbeat', { foreground: true, roomId: id, revision: 1 }); }
  assert.equal((await ack(stranger, 'typing', { roomId: id })).status, 403);
  assert.equal((await ack(stranger, 'start-recording', { roomId: id })).status, 403);
  const privacyA = event(a, 'privacy:changed'); const privacyB = event(b, 'privacy:changed');
  assert.equal((await request(`/users/${member.userId}/block`, owner.token, 'POST')).status, 200);
  assert.equal((await privacyA).hidden, true); assert.equal((await privacyB).hidden, true);
  const snapshots = []; const leaked = [];
  const capture = value => { if (value.roomId === id) snapshots.push(value); };
  a.on('room-presence', capture);
  a.on('typing', value => leaked.push(value)); a.on('start-recording', value => leaked.push(value));
  await ack(b, 'typing', { roomId: id }); await ack(b, 'start-recording', { roomId: id });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(snapshots.length);
  for (const state of snapshots) for (const field of ['onlineUserIds', 'viewingUserIds', 'typingUserIds', 'recordingUserIds']) assert.ok(!state[field].includes(member.userId));
  assert.deepEqual(leaked, []);
  const reverse = event(b, 'room-presence');
  await ack(a, 'typing', { roomId: id });
  assert.ok(!(await reverse).typingUserIds.includes(owner.userId));
  // Unblocking one direction does not override a block set by the other user.
  await request(`/users/${owner.userId}/block`, member.token, 'POST');
  const stillHidden = event(a, 'privacy:changed');
  await request(`/users/${member.userId}/block`, owner.token, 'DELETE');
  assert.equal((await stillHidden).hidden, true);
  a.off('room-presence', capture);
});

test('activity flood is bounded without preventing another device from stopping its state', async () => {
  const owner = await account(); const member = await account(); const id = await room(owner, member);
  const a = await open(member.token); const b = await open(member.token, 1);
  for (const socket of [a, b]) { await ack(socket, 'join-room', { roomId: id }); await ack(socket, 'heartbeat', { foreground: true, roomId: id, revision: 1 }); }
  await ack(b, 'typing', { roomId: id });
  const responses = await Promise.all(Array.from({ length: 30 }, () => ack(a, 'typing', { roomId: id })));
  assert.ok(responses.some(response => response.status === 429));
  const limiter = require('../src/middlewares/rateLimit.middleware');
  await Promise.all(Array.from({ length: 120 }, () => limiter.consumeShared(`activity:${member.userId}`, { windowMs: 60000, max: 120 })));
  assert.equal((await ack(b, 'start-recording', { roomId: id })).status, 429, 'account start quota is shared across instances');
  assert.equal((await ack(b, 'stop-typing', { roomId: id })).ok, true);
});

test('reads require foreground attention, acknowledge exact messages and close pointer gaps on resume', async () => {
  const owner = await account(); const member = await account(); const id = await room(owner, member, 'dm');
  const peer = await open(member.token, 1);
  const first = (await request('/messages', owner.token, 'POST', { roomId: id, content: 'First unseen message' })).body.data;
  const last = (await request('/messages', owner.token, 'POST', { roomId: id, content: 'Jump target' })).body.data;
  assert.equal(first.receipt_summary.recipient_count, 1, 'DM messages have exactly one recipient');
  assert.equal((await ack(peer, 'message-delivered', { roomId: id, messageId: last.id })).ok, true, 'delivery of fetched metadata does not require a subscription');
  await ack(peer, 'join-room', { roomId: id });
  assert.equal((await ack(peer, 'message-read', { roomId: id, messageId: last.id })).status, 409);
  await ack(peer, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  const result = await ack(peer, 'message-read', { roomId: id, messageId: last.id });
  assert.equal(result.ok, true);
  const rows = await query('SELECT message_id, read, delivered FROM message_recipients WHERE message_id=ANY($1::uuid[]) ORDER BY message_id', [[first.id,last.id]]);
  assert.equal(rows.rows.find(row => row.message_id === first.id).read, false);
  assert.equal(rows.rows.find(row => row.message_id === last.id).read, true);
  assert.equal(rows.rows.find(row => row.message_id === last.id).delivered, true, 'reading implies delivery');
  assert.equal(Number(result.data.last_seen_sequence), 0, 'a jump cannot consume the earlier unread message');
  const list = (await request('/rooms', member.token)).body.data;
  assert.equal(list.find(item => item.id === id).unread_count, 1, 'a later read message is excluded from the unread badge');
  await ack(peer, 'heartbeat', { foreground: false, roomId: null, revision: 2 });
  assert.equal((await ack(peer, 'message-read', { roomId: id, messageId: first.id })).status, 409);
  assert.equal((await ack(peer, 'message-delivered', { roomId: id, messageId: first.id })).ok, true, 'background delivery remains valid');
  await ack(peer, 'heartbeat', { foreground: true, roomId: id, revision: 3 });
  const resumed = await ack(peer, 'message-read', { roomId: id, messageId: first.id });
  assert.equal(Number(resumed.data.last_seen_sequence), Number(last.room_sequence));
  assert.equal((await ack(peer, 'message-read', { roomId: id, messageId: randomUUID() })).status, 404);
});

test('receipt recipient lists survive joins, removals, rejoins and multiple devices', async () => {
  const owner = await account(); const member = await account(); const removed = await account(); const added = await account();
  const id = await room(owner, member);
  assert.equal((await request(`/rooms/${id}/members`, owner.token, 'POST', { userId: removed.userId })).status, 201);
  const message = (await request('/messages', owner.token, 'POST', { roomId: id, content: 'Stable audience' })).body.data;
  assert.equal(message.receipt_summary.recipient_count, 2);
  const peer = await open(member.token, 1); await ack(peer, 'join-room', { roomId: id });
  await ack(peer, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  await ack(peer, 'message-delivered', { roomId: id, messageId: message.id });
  let details = (await request(`/messages/${message.id}/receipts`, owner.token)).body.data;
  assert.equal(details.summary.delivered_count, 1); assert.equal(details.summary.read_count, 0);
  await ack(peer, 'message-read', { roomId: id, messageId: message.id });
  details = (await request(`/messages/${message.id}/receipts`, owner.token)).body.data;
  const version = details.summary.version;
  const readAt = details.recipients.find(row => row.user_id === member.userId).read_at;
  const other = await open((await session(member.userId)).token);
  await ack(other, 'join-room', { roomId: id }); await ack(other, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  await ack(other, 'message-read', { roomId: id, messageId: message.id });
  const duplicate = (await request(`/messages/${message.id}/receipts`, owner.token)).body.data;
  assert.equal(duplicate.summary.version, version);
  assert.equal(duplicate.recipients.find(row => row.user_id === member.userId).read_at, readAt);
  assert.equal((await request(`/rooms/${id}/members/${removed.userId}`, owner.token, 'DELETE')).status, 200);
  assert.equal((await request(`/rooms/${id}/members`, owner.token, 'POST', { userId: added.userId })).status, 201);
  details = (await request(`/messages/${message.id}/receipts`, owner.token)).body.data;
  assert.equal(details.summary.recipient_count, 2); assert.equal(details.summary.read_count, 1);
  assert.equal(details.recipients.find(row => row.user_id === removed.userId).current_member, false);
  assert.ok(!details.recipients.some(row => row.user_id === added.userId));
  const newcomer = await open(added.token); await ack(newcomer, 'join-room', { roomId: id });
  await ack(newcomer, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  await ack(newcomer, 'message-read', { roomId: id, messageId: message.id });
  assert.equal((await request(`/messages/${message.id}/receipts`, owner.token)).body.data.summary.read_count, 1, 'reading history cannot add a new recipient');
  const newer = (await request('/messages', owner.token, 'POST', { roomId: id, content: 'New audience' })).body.data;
  const fresh = (await request(`/messages/${newer.id}/receipts`, owner.token)).body.data;
  assert.deepEqual(new Set(fresh.recipients.map(row => row.user_id)), new Set([member.userId, added.userId]));
  await request(`/rooms/${id}/members`, owner.token, 'POST', { userId: removed.userId });
  assert.equal((await request(`/messages/${message.id}/receipts`, owner.token)).body.data.summary.recipient_count, 2);
  const history = (await request(`/messages/room/${id}`, owner.token)).body.data.messages;
  assert.equal(history.find(row => row.id === message.id).receipt_summary.read_count, 1);
});

test('receipt details are author-only and reconnect summaries are membership scoped', async () => {
  const owner = await account(); const member = await account(); const outsider = await account(); const id = await room(owner, member);
  const message = (await request('/messages', owner.token, 'POST', { roomId: id, content: 'Private receipt details' })).body.data;
  assert.equal((await request(`/messages/${message.id}/receipts`, member.token)).status, 404);
  assert.equal((await request(`/messages/${message.id}/receipts`, outsider.token)).status, 404);
  assert.equal((await request(`/messages/room/${id}/receipts?ids=${message.id}`, outsider.token)).status, 403);
  const summary = await request(`/messages/room/${id}/receipts?ids=${message.id}`, owner.token);
  assert.equal(summary.body.data.receipts[0].receipt_summary.recipient_count, 1);
  assert.equal((await request(`/messages/room/${id}/receipts?ids=bad`, owner.token)).status, 400);
  const otherId = await room(outsider, member);
  const alien = (await request('/messages', outsider.token, 'POST', { roomId: otherId, content: 'Another room' })).body.data;
  assert.deepEqual((await request(`/messages/room/${id}/receipts?ids=${alien.id}`, owner.token)).body.data.receipts, []);
  const peer = await open(member.token); await ack(peer, 'join-room', { roomId: id });
  await request(`/rooms/${id}/members/${member.userId}`, owner.token, 'DELETE');
  assert.equal((await ack(peer, 'message-delivered', { roomId: id, messageId: message.id })).status, 403);
});

test('explicit mark read updates durable recipient receipts without changing their original audience', async () => {
  const owner = await account(); const member = await account(); const id = await room(owner, member);
  const message = (await request('/messages', owner.token, 'POST', { roomId: id, content: 'Mark all intentionally' })).body.data;
  assert.equal((await request(`/rooms/${id}/seen`, member.token, 'POST')).status, 200);
  const details = (await request(`/messages/${message.id}/receipts`, owner.token)).body.data;
  assert.equal(details.summary.read_count, 1); assert.equal(details.summary.delivered_count, 1);
  assert.ok(details.recipients[0].read_at); assert.ok(details.recipients[0].delivered_at);
  await request(`/rooms/${id}/members/${member.userId}`, owner.token, 'DELETE');
  const solo = (await request('/messages', owner.token, 'POST', { roomId: id, content: 'No other recipients' })).body.data;
  assert.equal(solo.receipt_summary.recipient_count, 0);
  assert.equal(solo.receipt_summary.read_count, 0);
});
