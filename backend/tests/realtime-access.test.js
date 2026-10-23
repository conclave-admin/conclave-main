"use strict";

// Real PostgreSQL, Redis adapter and two independently listening Socket.IO
// servers. A disposable database prevents this suite touching application data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { Client } = require("pg");
const { Server } = require("socket.io");
const { io: connect } = require("socket.io-client");
const { createAdapter } = require("@socket.io/redis-adapter");
const jwt = require("jsonwebtoken");
require("dotenv").config({ quiet: true });
const adminUrl =
  process.env.DATABASE_URL || "postgres://app:app@127.0.0.1:5432/postgres";
const database = `conclave_security_${randomBytes(12).toString("hex")}`;
process.env.RATE_LIMIT_KEY_PREFIX = `${database}:rate-limit`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${database}`;
process.env.DATABASE_URL = databaseUrl.toString();
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";
process.env.JWT_ACCESS_SECRET ||= "security-test-access";
process.env.JWT_REFRESH_SECRET ||= "security-test-refresh";
const { pool, query } = require("../src/config/db");
const { redisClient, connectRedis } = require("../src/config/redis");
const presence = require("../src/services/presence.service");
const app = require("../src/app");
const registerSockets = require("../src/sockets");
const {
  signAccessToken,
  signRefreshToken,
} = require("../src/services/token.service");
const servers = [];
const sockets = [];
const redisPeers = [];
const users = [];
const roomIds = [];
let admin;
let created = false;

async function request(path, token, method = "GET", body) {
  const response = await fetch(`${servers[0].url}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(name, done);
      reject(new Error(`Timed out waiting for ${name}`));
    }, 6000);
    function done(value) {
      clearTimeout(timeout);
      resolve(value);
    }
    socket.once(name, done);
  });
}
async function open(token, instance = 0) {
  const socket = connect(servers[instance].url, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
    autoConnect: false,
  });
  sockets.push(socket);
  const ready = event(socket, "connect");
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
  await query(
    "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)",
    [id, `${id}@security.test`, "unused", "Security fixture"],
  );
  users.push(id);
  return session(id);
}
async function session(userId) {
  const sessionId = randomUUID();
  await query(
    "INSERT INTO auth_sessions (id,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '7 days')",
    [sessionId, userId],
  );
  const user = { id: userId, sessionId };
  const token = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  await query(
    "INSERT INTO refresh_tokens (user_id,token_hash,expires_at,session_id) VALUES ($1,$2,NOW()+INTERVAL '7 days',$3)",
    [
      userId,
      createHash("sha256").update(refreshToken).digest("hex"),
      sessionId,
    ],
  );
  return { userId, sessionId, token, refreshToken };
}
async function room(owner, member, type = "group") {
  const id = randomUUID();
  await query(
    "INSERT INTO rooms (id,name,type,created_by,slug) VALUES ($1,'Security fixture',$4,$2,$3)",
    [id, owner.userId, id, type],
  );
  await query(
    "INSERT INTO room_members (room_id,user_id,role) VALUES ($1,$2,'admin'),($1,$3,'member')",
    [id, owner.userId, member.userId],
  );
  roomIds.push(id);
  return id;
}

async function startInstance(port = 0) {
  const http = require("node:http").createServer(app);
  const io = new Server(http);
  const pub = redisClient.duplicate();
  const sub = redisClient.duplicate();
  await Promise.all([pub.connect(), sub.connect()]);
  redisPeers.push(pub, sub);
  io.adapter(createAdapter(pub, sub, { key: database, requestsTimeout: 3000 }));
  registerSockets(io);
  await new Promise((resolve) => http.listen(port, "127.0.0.1", resolve));
  const instance = { io, http, url: `http://127.0.0.1:${http.address().port}` };
  servers.push(instance);
  return instance;
}

test.before(async () => {
  admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  created = true;
  require("node:child_process").execFileSync(
    process.execPath,
    ["database/migrate.js"],
    {
      cwd: require("node:path").join(__dirname, ".."),
      env: process.env,
      stdio: "pipe",
    },
  );
  await connectRedis();
  for (let index = 0; index < 2; index++) {
    await startInstance();
  }
  app.set("io", servers[0].io);
  // Redis subscription registration is asynchronous after adapter creation.
  for (
    let attempt = 0;
    attempt < 50 && (await servers[0].io.of("/").adapter.serverCount()) !== 2;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await servers[0].io.of("/").adapter.serverCount(), 2);
});
test.after(async () => {
  for (const socket of sockets) socket.disconnect();
  // Let async disconnect presence handlers finish before closing Redis peers.
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const { io } of servers)
    await new Promise((resolve) => io.close(resolve));
  presence.stopHeartbeatSweep();
  await presence.drainCleanup();
  for (const peer of redisPeers) if (peer.isOpen) await peer.quit();
  // Only remove this suite's UUID-scoped presence records; never FLUSHDB.
  if (redisClient.isOpen) {
    const keys = [];
    for await (const key of redisClient.scanIterator({
      MATCH: "*",
      COUNT: 100,
    })) {
      if (
        key.startsWith(`${database}:`) ||
        [
          ...users,
          ...roomIds,
          ...sockets.map((socket) => socket.testId).filter(Boolean),
        ].some((id) => key.includes(id))
      )
        keys.push(key);
    }
    if (keys.length) await redisClient.del(keys);
    for (const id of users) await redisClient.sRem("online_users", id);
    if (roomIds.length) await redisClient.sRem("activity:rooms", roomIds);
    await redisClient.quit();
  }
  await pool.end();
  if (admin) {
    if (created) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const active = await admin.query(
          "SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=$1",
          [database],
        );
        if (!active.rows[0].count) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
        [database],
      );
      await admin.query(`DROP DATABASE ${database}`);
    }
    await admin.end();
  }
});

test("removal evicts every device across two servers and cleans presence and typing", async () => {
  const owner = await account();
  const member = await account();
  const otherDevice = await session(member.userId);
  const id = await room(owner, member);
  const remaining = await open(owner.token);
  const a = await open(member.token);
  const b = await open(otherDevice.token, 1);
  for (const socket of [remaining, a, b]) {
    socket.testId = socket.id;
    assert.equal((await ack(socket, "join-room", { roomId: id })).ok, true);
  }
  await ack(b, "heartbeat", { foreground: true, roomId: id, revision: 1 });
  const typing = event(remaining, "typing");
  b.emit("typing", { roomId: id });
  await typing;
  assert.ok((await presence.getTypingUsers(id)).includes(member.userId));
  const changeA = event(a, "room:members");
  const changeB = event(b, "room:members");
  const result = await request(
    `/rooms/${id}/members/${member.userId}`,
    owner.token,
    "DELETE",
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await changeA).action, "removed");
  assert.equal((await changeB).action, "removed");
  for (const server of servers) {
    const subscribers = await server.io.in(id).fetchSockets();
    assert.ok(
      subscribers.every((socket) => socket.data.userId !== member.userId),
    );
  }
  assert.deepEqual(await presence.getRoomOnlineUsers(id), [owner.userId]);
  assert.deepEqual(await presence.getTypingUsers(id), []);
  for (const socket of [a, b]) {
    assert.equal(
      await redisClient.sIsMember(`socket:${socket.id}:rooms`, id),
      false,
    );
    assert.equal((await ack(socket, "join-room", { roomId: id })).status, 403);
    assert.equal((await ack(socket, "typing", { roomId: id })).status, 403);
    assert.equal(
      (await ack(socket, "send-message", { roomId: id, content: "Forbidden" }))
        .status,
      404,
    );
  }
  assert.equal((await request(`/rooms/${id}`, member.token)).status, 403);
  const leaked = [];
  const events = [
    "receive-message",
    "message:updated",
    "message:deleted",
    "message:reaction",
    "message:pinned",
    "poll:updated",
    "typing",
    "room:updated",
  ];
  for (const socket of [a, b])
    for (const name of events) socket.on(name, (value) => leaked.push(value));
  for (const { io } of servers) {
    for (const name of events) {
      const received = event(remaining, name);
      io.to(id).emit(name, { roomId: id, marker: "authorized only" });
      await received;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(leaked, []);
});

test("leaving a room evicts another connected device too", async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const a = await open(member.token);
  const b = await open(member.token, 1);
  await Promise.all(
    [a, b].map((socket) => ack(socket, "join-room", { roomId: id })),
  );
  const changed = event(b, "room:members");
  assert.equal(
    (
      await request(
        `/rooms/${id}/members/${member.userId}`,
        member.token,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal((await changed).action, "left");
  assert.equal((await servers[0].io.in(id).fetchSockets()).length, 0);
});

test("an in-flight join cannot restore membership while removal commits", async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const socket = await open(member.token, 1);
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM rooms WHERE id=$1 FOR UPDATE", [id]);
    const joining = ack(socket, "join-room", { roomId: id });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const removing = request(
      `/rooms/${id}/members/${member.userId}`,
      owner.token,
      "DELETE",
    );
    await blocker.query("COMMIT");
    const [join, removal] = await Promise.all([joining, removing]);
    assert.ok(join.ok || join.status === 403);
    assert.equal(removal.status, 200);
    assert.equal((await servers[0].io.in(id).fetchSockets()).length, 0);
    assert.deepEqual(await presence.getRoomOnlineUsers(id), []);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

test("logout revokes rotated tokens and connected sockets across servers, preserving other sessions", async () => {
  const original = await account();
  const independent = await session(original.userId);
  const rotated = await request("/auth/refresh", null, "POST", {
    refreshToken: original.refreshToken,
  });
  assert.equal(rotated.status, 200);
  assert.equal(
    jwt.decode(rotated.body.data.accessToken).sid,
    original.sessionId,
  );
  assert.equal(
    (
      await request("/auth/refresh", null, "POST", {
        refreshToken: original.refreshToken,
      })
    ).status,
    401,
  );
  const a = await open(original.token);
  const b = await open(rotated.body.data.accessToken, 1);
  const survivor = await open(independent.token, 1);
  const disconnected = [event(a, "disconnect"), event(b, "disconnect")];
  // Even the pre-rotation refresh token revokes the stable session.
  assert.equal(
    (
      await request("/auth/logout", null, "POST", {
        refreshToken: original.refreshToken,
      })
    ).status,
    200,
  );
  await Promise.all(disconnected);
  assert.equal(survivor.connected, true);
  assert.equal((await request("/users/me", original.token)).status, 401);
  assert.equal(
    (await request("/users/me", rotated.body.data.accessToken)).status,
    401,
  );
  assert.equal(
    (
      await request("/auth/refresh", null, "POST", {
        refreshToken: rotated.body.data.refreshToken,
      })
    ).status,
    401,
  );
  assert.equal((await request("/users/me", independent.token)).status, 200);
  const rejected = connect(servers[1].url, {
    auth: { token: original.token },
    reconnection: false,
    autoConnect: false,
  });
  sockets.push(rejected);
  const denied = event(rejected, "connect_error");
  rejected.connect();
  assert.equal((await denied).data.code, "SESSION_REVOKED");
});

test("idle sockets expire and can reconnect after refreshing an active session", async () => {
  const member = await account();
  const short = jwt.sign(
    { sub: member.userId, sid: member.sessionId },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: 2 },
  );
  const socket = await open(short, 1);
  const expired = event(socket, "session:expired");
  const disconnected = event(socket, "disconnect");
  assert.equal((await expired).sessionId, member.sessionId);
  await disconnected;
  const renewed = await request("/auth/refresh", null, "POST", {
    refreshToken: member.refreshToken,
  });
  assert.equal(renewed.status, 200);
  const next = await open(renewed.body.data.accessToken, 1);
  assert.equal(next.connected, true);
});

test("tokens without a durable session and expired database sessions are rejected", async () => {
  const member = await account();
  const legacy = jwt.sign(
    { sub: member.userId },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: "15m" },
  );
  assert.equal((await request("/users/me", legacy)).status, 401);
  await query(
    "UPDATE auth_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [member.sessionId],
  );
  assert.equal((await request("/users/me", member.token)).status, 401);
  assert.equal(
    (
      await request("/auth/refresh", null, "POST", {
        refreshToken: member.refreshToken,
      })
    ).status,
    401,
  );
});

test("a peer eviction failure rolls removal back and requests client resynchronization", async (t) => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const socket = await open(member.token);
  assert.equal((await ack(socket, "join-room", { roomId: id })).ok, true);
  const namespace = servers[1].io.of("/");
  const name = "security:revoke-access";
  const original = namespace.listeners(name);
  namespace.removeAllListeners(name);
  namespace.on(name, (_request, acknowledge) => acknowledge({ ok: false }));
  t.after(() => {
    namespace.removeAllListeners(name);
    for (const handler of original) namespace.on(name, handler);
  });
  const resync = event(socket, "room:resync");
  const response = await request(
    `/rooms/${id}/members/${member.userId}`,
    owner.token,
    "DELETE",
  );
  assert.equal(response.status, 503);
  assert.equal((await resync).roomId, id);
  assert.equal(
    (
      await query(
        "SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2",
        [id, member.userId],
      )
    ).rows.length,
    1,
  );
  assert.equal((await ack(socket, "join-room", { roomId: id })).ok, true);
});

test("room presence distinguishes connected elsewhere, foreground viewing and typing", async () => {
  const owner = await account();
  const member = await account();
  const outsider = await account();
  const id = await room(owner, member);
  const watcher = await open(owner.token);
  const peer = await open(member.token, 1);
  await ack(watcher, "join-room", { roomId: id });
  await ack(peer, "heartbeat", { foreground: true, roomId: null, revision: 1 });
  let snapshot = await presence.getRoomPresence(id);
  assert.ok(snapshot.onlineUserIds.includes(member.userId));
  assert.ok(!snapshot.viewingUserIds.includes(member.userId));
  await ack(peer, "join-room", { roomId: id });
  assert.ok(
    !(await presence.getRoomPresence(id)).viewingUserIds.includes(
      member.userId,
    ),
    "subscription is not foreground attention",
  );
  await ack(peer, "heartbeat", { foreground: true, roomId: id, revision: 2 });
  assert.ok(
    (await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId),
  );
  const typing = event(watcher, "typing");
  peer.emit("typing", { roomId: id });
  await typing;
  assert.ok(
    (await presence.getRoomPresence(id)).typingUserIds.includes(member.userId),
  );
  await ack(peer, "heartbeat", {
    foreground: false,
    roomId: null,
    revision: 3,
  });
  snapshot = await presence.getRoomPresence(id);
  assert.ok(snapshot.onlineUserIds.includes(member.userId));
  assert.ok(!snapshot.viewingUserIds.includes(member.userId));
  assert.ok(!snapshot.typingUserIds.includes(member.userId));
  // A delayed foreground packet cannot undo the newer background state.
  await ack(peer, "heartbeat", { foreground: true, roomId: id, revision: 2 });
  assert.ok(
    !(await presence.getRoomPresence(id)).viewingUserIds.includes(
      member.userId,
    ),
  );
  await ack(peer, "heartbeat", { foreground: true, roomId: id, revision: 4 });
  await ack(peer, "typing", { roomId: id });
  assert.equal((await peer.timeout(6000).emitWithAck("heartbeat")).ok, true);
  assert.deepEqual(
    (await presence.getRoomPresence(id)).typingUserIds,
    [],
    "legacy heartbeat clears activity without claiming attention",
  );
  const stranger = await open(outsider.token, 1);
  await ack(stranger, "heartbeat", {
    foreground: true,
    roomId: id,
    revision: 1,
  });
  snapshot = await presence.getRoomPresence(id);
  assert.ok(!snapshot.onlineUserIds.includes(outsider.userId));
  assert.ok(!snapshot.viewingUserIds.includes(outsider.userId));
});

test("one healthy device cannot keep a sleeping device or its room indexes alive", async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const sleeping = await open(member.token);
  const awake = await open(member.token, 1);
  await ack(sleeping, "join-room", { roomId: id });
  await ack(sleeping, "heartbeat", {
    foreground: true,
    roomId: id,
    revision: 1,
  });
  await ack(awake, "heartbeat", {
    foreground: true,
    roomId: null,
    revision: 1,
  });
  await redisClient.zAdd("presence:leases", {
    score: Date.now() - 1,
    value: `${member.userId}:${sleeping.id}`,
  });
  assert.equal(await presence.isUserOnline(member.userId), true);
  assert.ok(
    !(await presence.getRoomPresence(id)).viewingUserIds.includes(
      member.userId,
    ),
  );
  await presence.sweepStaleSockets();
  assert.equal(await redisClient.exists(`presence:socket:${sleeping.id}`), 0);
  assert.equal(
    await redisClient.sIsMember(`user:${member.userId}:sockets`, sleeping.id),
    false,
  );
  assert.equal(
    await redisClient.sIsMember(
      `room:${id}:user:${member.userId}:sockets`,
      sleeping.id,
    ),
    false,
  );
  assert.equal(await redisClient.exists(`socket:${sleeping.id}:rooms`), 0);
  assert.equal(await presence.isUserOnline(member.userId), true);
  await ack(sleeping, "heartbeat", {
    foreground: true,
    roomId: id,
    revision: 2,
  });
  assert.ok(
    (await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId),
    "resuming restores the device and its room",
  );
  assert.equal(
    await redisClient.sIsMember(`socket:${sleeping.id}:rooms`, id),
    true,
  );
  assert.equal(
    (await ack(sleeping, "typing", { roomId: id })).data.accepted,
    true,
    "typing resumes after a device lease expired",
  );
  await ack(awake, "join-room", { roomId: id });
  await ack(sleeping, "leave-room", { roomId: id });
  assert.ok(
    !(await presence.getRoomPresence(id)).viewingUserIds.includes(
      member.userId,
    ),
    "a background subscription does not retain foreground attention",
  );
  assert.equal(await presence.isUserOnline(member.userId), true);
});

test("sweep does not remove a device renewed after the expiry candidate was selected", async () => {
  const member = await account();
  const socket = await open(member.token);
  await ack(socket, "heartbeat", {
    foreground: true,
    roomId: null,
    revision: 1,
  });
  const oldDeadline = Date.now() - 1;
  await redisClient.zAdd("presence:leases", {
    score: oldDeadline,
    value: `${member.userId}:${socket.id}`,
  });
  await presence.renewSocket(member.userId, socket.id, { foreground: true });
  await presence.sweepStaleSockets(oldDeadline + 1);
  assert.equal(await presence.isUserOnline(member.userId), true);
  assert.equal(await redisClient.exists(`presence:socket:${socket.id}`), 1);
});

test("orphaned indexes are pruned even when a reverse index or lease was lost", async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const dead = `crashed-${randomUUID()}`;
  await presence.socketConnected(member.userId, dead);
  await presence.userJoinedRoom(member.userId, id, dead);
  await redisClient.del(`socket:${dead}:rooms`);
  await redisClient.zRem("presence:leases", `${member.userId}:${dead}`);
  await redisClient.sAdd(`user:${member.userId}:rooms`, randomUUID());
  await presence.reconcilePresenceIndexes();
  assert.equal(await redisClient.exists(`presence:socket:${dead}`), 0);
  assert.equal(
    await redisClient.sIsMember(`room:${id}:online`, member.userId),
    false,
  );
  assert.equal(await redisClient.exists(`user:${member.userId}:rooms`), 0);
  assert.equal(await presence.isUserOnline(member.userId), false);
});

test("Redis data loss and a presence connection outage recover from existing authenticated sockets", async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const socket = await open(member.token, 1);
  await ack(socket, "join-room", { roomId: id });
  await ack(socket, "heartbeat", { foreground: true, roomId: id, revision: 1 });
  // Delete only this fixture's records, simulating lost volatile Redis state.
  const keys = [];
  for await (const key of redisClient.scanIterator({
    MATCH: "*",
    COUNT: 100,
  })) {
    if ([member.userId, id, socket.id].some((value) => key.includes(value)))
      keys.push(key);
  }
  if (keys.length) await redisClient.del(keys);
  await redisClient.zRem("presence:leases", `${member.userId}:${socket.id}`);
  await redisClient.sRem("online_users", member.userId);
  assert.ok(
    !(await presence.getRoomPresence(id)).onlineUserIds.includes(member.userId),
  );
  await ack(socket, "heartbeat", { foreground: true, roomId: id, revision: 2 });
  assert.ok(
    (await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId),
  );
  assert.equal(
    await redisClient.sIsMember(`socket:${socket.id}:rooms`, id),
    true,
  );
  const unavailable = event(socket, "presence:unavailable");
  await redisClient.disconnect();
  await unavailable;
  assert.equal((await presence.getRoomPresence(id)).available, false);
  const resync = event(socket, "presence:resync");
  await connectRedis();
  await resync;
  await ack(socket, "heartbeat", { foreground: true, roomId: id, revision: 3 });
  assert.equal((await presence.getRoomPresence(id)).available, true);
  assert.ok(
    (await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId),
  );
});

test("a database lookup outage yields unknown presence and recovers without inventing offline state", async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const socket = await open(member.token);
  await ack(socket, "heartbeat", { foreground: true, roomId: id, revision: 1 });
  const failed = await presence.getRoomPresence(id, {
    query: async () => {
      throw new Error("Simulated database outage");
    },
  });
  assert.equal(failed.available, false);
  assert.deepEqual(failed.onlineUserIds, []);
  const recovered = await presence.getRoomPresence(id);
  assert.equal(recovered.available, true);
  assert.ok(recovered.viewingUserIds.includes(member.userId));
});

test("an API server restart reconnects the client and removes the crashed socket lease", async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const server = await startInstance();
  const client = await open(member.token, servers.length - 1);
  await ack(client, "join-room", { roomId: id });
  await ack(client, "heartbeat", { foreground: true, roomId: id, revision: 1 });
  const oldId = client.id;
  // Simulate abrupt process loss: Redis receives no disconnect cleanup.
  const oldSocket = server.io.of("/").sockets.get(oldId);
  oldSocket.removeAllListeners("disconnect");
  client.io.reconnection(true);
  client.io.reconnectionDelay(100);
  client.io.reconnectionDelayMax(200);
  const reconnected = event(client, "connect");
  oldSocket.conn.close();
  const port = server.http.address().port;
  await new Promise((resolve) => server.io.close(resolve));
  await startInstance(port);
  await reconnected;
  assert.notEqual(client.id, oldId);
  await ack(client, "join-room", { roomId: id });
  await ack(client, "heartbeat", { foreground: true, roomId: id, revision: 2 });
  await redisClient.zAdd("presence:leases", {
    score: Date.now() - 1,
    value: `${member.userId}:${oldId}`,
  });
  await presence.sweepStaleSockets();
  assert.equal(await redisClient.exists(`presence:socket:${oldId}`), 0);
  assert.ok(
    (await presence.getRoomPresence(id)).viewingUserIds.includes(member.userId),
  );
});

test("typing and recording aggregate devices and expire both initial snapshots and device state", async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const observer = await open(owner.token);
  const a = await open(member.token);
  const b = await open(member.token, 1);
  for (const socket of [observer, a, b]) {
    await ack(socket, "join-room", { roomId: id });
    await ack(socket, "heartbeat", {
      foreground: true,
      roomId: id,
      revision: 1,
    });
  }
  assert.equal((await ack(a, "typing", { roomId: id })).data.accepted, true);
  await ack(b, "typing", { roomId: id });
  await ack(a, "stop-typing", { roomId: id });
  assert.ok(
    (await presence.getRoomPresence(id)).typingUserIds.includes(member.userId),
  );
  await ack(a, "start-recording", { roomId: id });
  let state = await presence.getRoomPresence(id);
  assert.ok(state.recordingUserIds.includes(member.userId));
  assert.ok(
    state.typingUserIds.includes(member.userId),
    "another device is still typing",
  );
  await ack(a, "stop-recording", { roomId: id });
  assert.ok(
    !(await presence.getRoomPresence(id)).recordingUserIds.includes(
      member.userId,
    ),
  );
  assert.ok(
    (await presence.getRoomPresence(id)).typingUserIds.includes(member.userId),
  );
  await ack(a, "start-recording", { roomId: id });
  await ack(a, "send-message", { roomId: id, content: "Sent from device A" });
  state = await presence.getRoomPresence(id);
  assert.ok(!state.recordingUserIds.includes(member.userId));
  assert.ok(
    state.typingUserIds.includes(member.userId),
    "sending on A must not stop B",
  );
  await ack(b, "heartbeat", { foreground: false, roomId: null, revision: 2 });
  assert.deepEqual((await presence.getRoomPresence(id)).typingUserIds, []);
  await ack(a, "typing", { roomId: id });
  const activity = require("../src/services/conversationActivity.service");
  assert.deepEqual(await activity.snapshot(id, Date.now() + 6000), []);
});

test("delayed starts cannot overwrite a later stop and recording rejects background devices", async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const socket = await open(member.token);
  await ack(socket, "join-room", { roomId: id });
  assert.equal(
    (await ack(socket, "start-recording", { roomId: id })).data.accepted,
    false,
  );
  await ack(socket, "heartbeat", { foreground: true, roomId: id, revision: 1 });
  const activity = require("../src/services/conversationActivity.service");
  const before = await activity.readSnapshot(id);
  await activity.update(id, member.userId, socket.id, "typing", false, 1000);
  const stopped = await activity.readSnapshot(id);
  assert.ok(stopped.version > before.version);
  assert.equal(
    await activity.update(id, member.userId, socket.id, "typing", true, 999),
    false,
  );
  assert.equal((await activity.readSnapshot(id)).version, stopped.version);
  assert.deepEqual(await activity.snapshot(id), []);
});

test("activity is private to members and symmetric blocks hide presence, typing and recording in shared groups", async () => {
  const owner = await account();
  const member = await account();
  const outsider = await account();
  const id = await room(owner, member);
  const a = await open(owner.token);
  const b = await open(member.token, 1);
  const stranger = await open(outsider.token, 1);
  for (const socket of [a, b]) {
    await ack(socket, "join-room", { roomId: id });
    await ack(socket, "heartbeat", {
      foreground: true,
      roomId: id,
      revision: 1,
    });
  }
  assert.equal((await ack(stranger, "typing", { roomId: id })).status, 403);
  assert.equal(
    (await ack(stranger, "start-recording", { roomId: id })).status,
    403,
  );
  const privacyA = event(a, "privacy:changed");
  const privacyB = event(b, "privacy:changed");
  assert.equal(
    (await request(`/users/${member.userId}/block`, owner.token, "POST"))
      .status,
    200,
  );
  assert.equal((await privacyA).hidden, true);
  assert.equal((await privacyB).hidden, true);
  const snapshots = [];
  const leaked = [];
  const capture = (value) => {
    if (value.roomId === id) snapshots.push(value);
  };
  a.on("room-presence", capture);
  a.on("typing", (value) => leaked.push(value));
  a.on("start-recording", (value) => leaked.push(value));
  await ack(b, "typing", { roomId: id });
  await ack(b, "start-recording", { roomId: id });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(snapshots.length);
  for (const state of snapshots)
    for (const field of [
      "onlineUserIds",
      "viewingUserIds",
      "typingUserIds",
      "recordingUserIds",
    ])
      assert.ok(!state[field].includes(member.userId));
  assert.deepEqual(leaked, []);
  const reverse = event(b, "room-presence");
  await ack(a, "typing", { roomId: id });
  assert.ok(!(await reverse).typingUserIds.includes(owner.userId));
  // Unblocking one direction does not override a block set by the other user.
  await request(`/users/${owner.userId}/block`, member.token, "POST");
  const stillHidden = event(a, "privacy:changed");
  await request(`/users/${member.userId}/block`, owner.token, "DELETE");
  assert.equal((await stillHidden).hidden, true);
  a.off("room-presence", capture);
});

test("activity flood is bounded without preventing another device from stopping its state", async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const a = await open(member.token);
  const b = await open(member.token, 1);
  for (const socket of [a, b]) {
    await ack(socket, "join-room", { roomId: id });
    await ack(socket, "heartbeat", {
      foreground: true,
      roomId: id,
      revision: 1,
    });
  }
  await ack(b, "typing", { roomId: id });
  const responses = await Promise.all(
    Array.from({ length: 30 }, () => ack(a, "typing", { roomId: id })),
  );
  assert.ok(responses.some((response) => response.status === 429));
  const limiter = require("../src/middlewares/rateLimit.middleware");
  await Promise.all(
    Array.from({ length: 120 }, () =>
      limiter.consumeShared(`activity:${member.userId}`, {
        windowMs: 60000,
        max: 120,
      }),
    ),
  );
  assert.equal(
    (await ack(b, "start-recording", { roomId: id })).status,
    429,
    "account start quota is shared across instances",
  );
  assert.equal((await ack(b, "stop-typing", { roomId: id })).ok, true);
});

test("reads require foreground attention, acknowledge exact messages and close pointer gaps on resume", async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member, "dm");
  const peer = await open(member.token, 1);
  const first = (
    await request("/messages", owner.token, "POST", {
      roomId: id,
      content: "First unseen message",
    })
  ).body.data;
  const last = (
    await request("/messages", owner.token, "POST", {
      roomId: id,
      content: "Jump target",
    })
  ).body.data;
  assert.equal(
    first.receipt_summary.recipient_count,
    1,
    "DM messages have exactly one recipient",
  );
  assert.equal(
    (await ack(peer, "message-delivered", { roomId: id, messageId: last.id }))
      .ok,
    true,
    "delivery of fetched metadata does not require a subscription",
  );
  await ack(peer, "join-room", { roomId: id });
  assert.equal(
    (await ack(peer, "message-read", { roomId: id, messageId: last.id }))
      .status,
    409,
  );
  await ack(peer, "heartbeat", { foreground: true, roomId: id, revision: 1 });
  const result = await ack(peer, "message-read", {
    roomId: id,
    messageId: last.id,
  });
  assert.equal(result.ok, true);
  const rows = await query(
    "SELECT message_id, read, delivered FROM message_recipients WHERE message_id=ANY($1::uuid[]) ORDER BY message_id",
    [[first.id, last.id]],
  );
  assert.equal(
    rows.rows.find((row) => row.message_id === first.id).read,
    false,
  );
  assert.equal(rows.rows.find((row) => row.message_id === last.id).read, true);
  assert.equal(
    rows.rows.find((row) => row.message_id === last.id).delivered,
    true,
    "reading implies delivery",
  );
  assert.equal(
    Number(result.data.last_seen_sequence),
    0,
    "a jump cannot consume the earlier unread message",
  );
  const list = (await request("/rooms", member.token)).body.data;
  assert.equal(
    list.find((item) => item.id === id).unread_count,
    1,
    "a later read message is excluded from the unread badge",
  );
  await ack(peer, "heartbeat", {
    foreground: false,
    roomId: null,
    revision: 2,
  });
  assert.equal(
    (await ack(peer, "message-read", { roomId: id, messageId: first.id }))
      .status,
    409,
  );
  assert.equal(
    (await ack(peer, "message-delivered", { roomId: id, messageId: first.id }))
      .ok,
    true,
    "background delivery remains valid",
  );
  await ack(peer, "heartbeat", { foreground: true, roomId: id, revision: 3 });
  const resumed = await ack(peer, "message-read", {
    roomId: id,
    messageId: first.id,
  });
  assert.equal(
    Number(resumed.data.last_seen_sequence),
    Number(last.room_sequence),
  );
  assert.equal(
    (await ack(peer, "message-read", { roomId: id, messageId: randomUUID() }))
      .status,
    404,
  );
});

test("receipt recipient lists survive joins, removals, rejoins and multiple devices", async () => {
  const owner = await account();
  const member = await account();
  const removed = await account();
  const added = await account();
  const id = await room(owner, member);
  assert.equal(
    (
      await request(`/rooms/${id}/members`, owner.token, "POST", {
        userId: removed.userId,
      })
    ).status,
    201,
  );
  const message = (
    await request("/messages", owner.token, "POST", {
      roomId: id,
      content: "Stable audience",
    })
  ).body.data;
  assert.equal(message.receipt_summary.recipient_count, 2);
  const peer = await open(member.token, 1);
  await ack(peer, "join-room", { roomId: id });
  await ack(peer, "heartbeat", { foreground: true, roomId: id, revision: 1 });
  await ack(peer, "message-delivered", { roomId: id, messageId: message.id });
  let details = (await request(`/messages/${message.id}/receipts`, owner.token))
    .body.data;
  assert.equal(details.summary.delivered_count, 1);
  assert.equal(details.summary.read_count, 0);
  await ack(peer, "message-read", { roomId: id, messageId: message.id });
  details = (await request(`/messages/${message.id}/receipts`, owner.token))
    .body.data;
  const version = details.summary.version;
  const readAt = details.recipients.find(
    (row) => row.user_id === member.userId,
  ).read_at;
  const other = await open((await session(member.userId)).token);
  await ack(other, "join-room", { roomId: id });
  await ack(other, "heartbeat", { foreground: true, roomId: id, revision: 1 });
  await ack(other, "message-read", { roomId: id, messageId: message.id });
  const duplicate = (
    await request(`/messages/${message.id}/receipts`, owner.token)
  ).body.data;
  assert.equal(duplicate.summary.version, version);
  assert.equal(
    duplicate.recipients.find((row) => row.user_id === member.userId).read_at,
    readAt,
  );
  assert.equal(
    (
      await request(
        `/rooms/${id}/members/${removed.userId}`,
        owner.token,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/rooms/${id}/members`, owner.token, "POST", {
        userId: added.userId,
      })
    ).status,
    201,
  );
  details = (await request(`/messages/${message.id}/receipts`, owner.token))
    .body.data;
  assert.equal(details.summary.recipient_count, 2);
  assert.equal(details.summary.read_count, 1);
  assert.equal(
    details.recipients.find((row) => row.user_id === removed.userId)
      .current_member,
    false,
  );
  assert.ok(!details.recipients.some((row) => row.user_id === added.userId));
  const newcomer = await open(added.token);
  await ack(newcomer, "join-room", { roomId: id });
  await ack(newcomer, "heartbeat", {
    foreground: true,
    roomId: id,
    revision: 1,
  });
  await ack(newcomer, "message-read", { roomId: id, messageId: message.id });
  assert.equal(
    (await request(`/messages/${message.id}/receipts`, owner.token)).body.data
      .summary.read_count,
    1,
    "reading history cannot add a new recipient",
  );
  const newer = (
    await request("/messages", owner.token, "POST", {
      roomId: id,
      content: "New audience",
    })
  ).body.data;
  const fresh = (await request(`/messages/${newer.id}/receipts`, owner.token))
    .body.data;
  assert.deepEqual(
    new Set(fresh.recipients.map((row) => row.user_id)),
    new Set([member.userId, added.userId]),
  );
  await request(`/rooms/${id}/members`, owner.token, "POST", {
    userId: removed.userId,
  });
  assert.equal(
    (await request(`/messages/${message.id}/receipts`, owner.token)).body.data
      .summary.recipient_count,
    2,
  );
  const history = (await request(`/messages/room/${id}`, owner.token)).body.data
    .messages;
  assert.equal(
    history.find((row) => row.id === message.id).receipt_summary.read_count,
    1,
  );
});

test("receipt details are author-only and reconnect summaries are membership scoped", async () => {
  const owner = await account();
  const member = await account();
  const outsider = await account();
  const id = await room(owner, member);
  const message = (
    await request("/messages", owner.token, "POST", {
      roomId: id,
      content: "Private receipt details",
    })
  ).body.data;
  assert.equal(
    (await request(`/messages/${message.id}/receipts`, member.token)).status,
    404,
  );
  assert.equal(
    (await request(`/messages/${message.id}/receipts`, outsider.token)).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/messages/room/${id}/receipts?ids=${message.id}`,
        outsider.token,
      )
    ).status,
    403,
  );
  const summary = await request(
    `/messages/room/${id}/receipts?ids=${message.id}`,
    owner.token,
  );
  assert.equal(
    summary.body.data.receipts[0].receipt_summary.recipient_count,
    1,
  );
  assert.equal(
    (await request(`/messages/room/${id}/receipts?ids=bad`, owner.token))
      .status,
    400,
  );
  const otherId = await room(outsider, member);
  const alien = (
    await request("/messages", outsider.token, "POST", {
      roomId: otherId,
      content: "Another room",
    })
  ).body.data;
  assert.deepEqual(
    (
      await request(
        `/messages/room/${id}/receipts?ids=${alien.id}`,
        owner.token,
      )
    ).body.data.receipts,
    [],
  );
  const peer = await open(member.token);
  await ack(peer, "join-room", { roomId: id });
  await request(`/rooms/${id}/members/${member.userId}`, owner.token, "DELETE");
  assert.equal(
    (
      await ack(peer, "message-delivered", {
        roomId: id,
        messageId: message.id,
      })
    ).status,
    403,
  );
});

test("explicit mark read updates durable recipient receipts without changing their original audience", async () => {
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const message = (
    await request("/messages", owner.token, "POST", {
      roomId: id,
      content: "Mark all intentionally",
    })
  ).body.data;
  assert.equal(
    (await request(`/rooms/${id}/seen`, member.token, "POST")).status,
    200,
  );
  const details = (
    await request(`/messages/${message.id}/receipts`, owner.token)
  ).body.data;
  assert.equal(details.summary.read_count, 1);
  assert.equal(details.summary.delivered_count, 1);
  assert.ok(details.recipients[0].read_at);
  assert.ok(details.recipients[0].delivered_at);
  await request(`/rooms/${id}/members/${member.userId}`, owner.token, "DELETE");
  const solo = (
    await request("/messages", owner.token, "POST", {
      roomId: id,
      content: "No other recipients",
    })
  ).body.data;
  assert.equal(solo.receipt_summary.recipient_count, 0);
  assert.equal(solo.receipt_summary.read_count, 0);
});

test("sync cursors include late commits and replay edits, deletions and reactions on old messages", async () => {
  const sync = require("../src/services/sync.service");
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const first = (
    await request("/messages", owner.token, "POST", {
      roomId: id,
      content: "Original",
    })
  ).body.data;
  const second = (
    await request("/messages", owner.token, "POST", {
      roomId: id,
      content: "Other message",
    })
  ).body.data;
  const baseline = await sync.replay(member.userId);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("UPDATE messages SET content=$2 WHERE id=$1", [
      first.id,
      "Late commit",
    ]);
    await query("UPDATE messages SET content=$2 WHERE id=$1", [
      second.id,
      "Fast commit",
    ]);
    const fast = await sync.replay(member.userId, baseline.cursor);
    assert.ok(fast.changes.some((c) => c.entity_id === second.id));
    assert.ok(!fast.changes.some((c) => c.entity_id === first.id));
    await db.query("COMMIT");
    const late = await sync.replay(member.userId, fast.cursor);
    assert.ok(late.changes.some((c) => c.entity_id === first.id));
    await query(
      "INSERT INTO message_reactions(message_id,user_id,emoji) VALUES($1,$2,'👍')",
      [first.id, member.userId],
    );
    await query(
      "UPDATE messages SET content=NULL,deleted_at=NOW() WHERE id=$1",
      [second.id],
    );
    const changes = await sync.replay(member.userId, late.cursor);
    assert.ok(changes.changes.some((c) => c.entity_id === first.id));
    assert.ok(changes.changes.some((c) => c.entity_id === second.id));
    const page = (
      await request(
        `/messages/room/${id}?ids=${first.id},${second.id}`,
        member.token,
      )
    ).body.data;
    assert.equal(
      page.messages.find((m) => m.id === first.id).content,
      "Late commit",
    );
    assert.equal(
      page.messages.find((m) => m.id === first.id).reactions[0].reacted,
      true,
    );
    assert.equal(page.messages.find((m) => m.id === second.id).content, null);
    assert.equal(
      page.messages.find((m) => m.id === second.id).is_deleted,
      true,
    );
    assert.ok(
      page.messages.find((m) => m.id === first.id).sync_version >
        first.sync_version,
    );
    assert.deepEqual(
      (await request(`/messages/room/${id}?ids=${randomUUID()}`, member.token))
        .body.data.missingIds.length,
      1,
    );
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    db.release();
  }
});

test("sync uses current membership, preserves removal invalidations and keeps private pins private", async () => {
  const sync = require("../src/services/sync.service");
  const owner = await account();
  const member = await account();
  const outsider = await account();
  const id = await room(owner, member);
  const message = (
    await request("/messages", owner.token, "POST", {
      roomId: id,
      content: "Visible before removal",
    })
  ).body.data;
  const before = await sync.replay(owner.userId);
  await query(
    "INSERT INTO message_pins(message_id,user_id,scope) VALUES($1,$2,'user')",
    [message.id, owner.userId],
  );
  const own = await sync.replay(owner.userId, before.cursor);
  const other = await sync.replay(member.userId, before.cursor);
  assert.ok(own.changes.some((c) => c.entity_id === message.id));
  assert.ok(!other.changes.some((c) => c.entity_id === message.id));
  await query("UPDATE users SET bio=$2 WHERE id=$1", [
    owner.userId,
    "Updated biography",
  ]);
  await query(
    "UPDATE room_members SET role=$3 WHERE room_id=$1 AND user_id=$2",
    [id, member.userId, "admin"],
  );
  const updated = await sync.replay(member.userId, other.cursor);
  assert.ok(updated.changes.some((c) => c.kind === "profile"));
  assert.ok(updated.changes.some((c) => c.kind === "membership"));
  await query(
    "UPDATE room_members SET role='member' WHERE room_id=$1 AND user_id=$2",
    [id, member.userId],
  );
  assert.equal(
    (
      await request(
        `/rooms/${id}/members/${member.userId}`,
        owner.token,
        "DELETE",
      )
    ).status,
    200,
  );
  await query("UPDATE messages SET content=$2 WHERE id=$1", [
    message.id,
    "Must not leak",
  ]);
  const removed = await sync.replay(member.userId, before.cursor);
  assert.ok(
    removed.changes.some(
      (c) =>
        c.kind === "membership" &&
        c.operation === "DELETE" &&
        c.user_id === member.userId,
    ),
  );
  assert.ok(!removed.changes.some((c) => c.kind === "message"));
  assert.ok(
    !(await sync.replay(outsider.userId, before.cursor)).changes.some(
      (c) => c.room_id === id,
    ),
  );
  assert.equal(
    (await request(`/messages/room/${id}?ids=${message.id}`, member.token))
      .status,
    403,
  );
  assert.equal((await request("/sync?after=bad", owner.token)).status, 400);
});

test("committed change outbox recovers a missing broadcast and notifications without duplication", async () => {
  const sync = require("../src/services/sync.service");
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const mid = randomUUID();
  const seq = await query(
    "UPDATE rooms SET message_sequence=message_sequence+1 WHERE id=$1 RETURNING message_sequence",
    [id],
  );
  await query(
    "INSERT INTO messages(id,room_id,sender_id,content,room_sequence) VALUES($1,$2,$3,$4,$5)",
    [
      mid,
      id,
      owner.userId,
      "Saved before a crash",
      seq.rows[0].message_sequence,
    ],
  );
  const broken = {
    to() {
      return {
        emit() {
          throw new Error("Simulated lost transport");
        },
      };
    },
  };
  await sync.dispatchChanges(broken, 1000);
  assert.equal(
    (
      await query(
        "SELECT COUNT(*)::int AS n FROM notifications WHERE reference_id=$1 AND recipient_id=$2",
        [mid, member.userId],
      )
    ).rows[0].n,
    1,
  );
  await query(
    "UPDATE sync_changes SET next_attempt_at=NOW(),lease_until=NULL WHERE entity_id=$1",
    [mid],
  );
  const events = [];
  const recovered = {
    to(target) {
      return {
        emit(name, payload) {
          events.push({ target, name, payload });
        },
      };
    },
  };
  await sync.dispatchChanges(recovered, 1000);
  assert.ok(events.some((e) => e.name === "sync:changed"));
  assert.equal(
    (
      await query(
        "SELECT delivered_at FROM sync_changes WHERE entity_id=$1 AND operation=$2",
        [mid, "INSERT"],
      )
    ).rows[0].delivered_at instanceof Date,
    true,
  );
  assert.equal(
    (
      await query(
        "SELECT COUNT(*)::int AS n FROM notifications WHERE reference_id=$1 AND recipient_id=$2",
        [mid, member.userId],
      )
    ).rows[0].n,
    1,
  );
  const retry = (
    await request("/messages", owner.token, "POST", {
      roomId: id,
      clientId: randomUUID(),
      content: "Stable acknowledgement",
    })
  ).body.data;
  const duplicate = await request("/messages", owner.token, "POST", {
    roomId: id,
    clientId: retry.client_id,
    content: "Stable acknowledgement",
  });
  assert.equal(duplicate.body.data.id, retry.id);
});

async function pushFixture(fn) {
  const env = require("../src/config/env");
  const previous = env.push;
  const keys = require("web-push").generateVAPIDKeys();
  env.push = {
    ...previous,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: "mailto:push-tests@example.test",
    allowedOrigins: [],
  };
  const owner = await account();
  const member = await account();
  const id = await room(owner, member);
  const crypto = require("node:crypto");
  const ecdh = crypto.createECDH("prime256v1");
  const subscription = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    keys: {
      p256dh: ecdh.generateKeys().toString("base64url"),
      auth: crypto.randomBytes(16).toString("base64url"),
    },
  };
  try {
    const registered = await request(
      "/push/subscriptions",
      member.token,
      "POST",
      { subscription },
    );
    assert.equal(registered.status, 201);
    await fn({
      owner,
      member,
      id,
      subscription,
      registration: registered.body.data,
      push: require("../src/services/push.service"),
    });
  } finally {
    await query("DELETE FROM push_subscriptions WHERE user_id=$1", [
      member.userId,
    ]);
    env.push = previous;
  }
}
async function pushMessage(f, text = "Private text never put in push") {
  const response = await request("/messages", f.owner.token, "POST", {
    roomId: f.id,
    content: text,
  });
  assert.equal(response.status, 201);
  return response.body.data;
}

test("push delivery retries transient failure, uses generic content and expires dead subscriptions", async () =>
  pushFixture(async (f) => {
    const message = await pushMessage(f);
    let calls = 0;
    await f.push.dispatch(100, async () => {
      calls++;
      const error = new Error("Provider unavailable");
      error.statusCode = 503;
      throw error;
    });
    assert.equal(calls, 1);
    assert.equal(
      (
        await query(
          "SELECT completed_at FROM push_jobs WHERE notification_id IN(SELECT id FROM notifications WHERE reference_id=$1)",
          [message.id],
        )
      ).rows[0].completed_at,
      null,
    );
    await query(
      "UPDATE push_jobs SET next_attempt_at=NOW() WHERE subscription_id=$1",
      [f.registration.subscriptionId],
    );
    await f.push.dispatch(100, async (sub, payload) => {
      const data = JSON.parse(payload);
      assert.equal(data.bindingId, f.registration.bindingId);
      assert.ok(!payload.includes(message.content));
      assert.equal(data.url, "/notifications");
      calls++;
    });
    assert.equal(calls, 2);
    assert.equal(
      (
        await query(
          "SELECT outcome FROM push_jobs WHERE notification_id IN(SELECT id FROM notifications WHERE reference_id=$1)",
          [message.id],
        )
      ).rows[0].outcome,
      "accepted",
    );
    await pushMessage(f, "Second");
    await f.push.dispatch(100, async () => {
      const error = new Error("Gone");
      error.statusCode = 410;
      throw error;
    });
    assert.equal(
      (
        await query(
          "SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id=$1",
          [f.member.userId],
        )
      ).rows[0].n,
      0,
    );
  }));

test("push enforces global, per-type and room preferences, blocks and active viewing at send time", async () =>
  pushFixture(async (f) => {
    const dispatch = async () => {
      let calls = 0;
      await f.push.dispatch(100, async () => {
        calls++;
      });
      return calls;
    };
    await query(
      "INSERT INTO notification_preferences(user_id,activity_level) VALUES($1,'none')",
      [f.member.userId],
    );
    await pushMessage(f);
    assert.equal(await dispatch(), 0);
    await query(
      "UPDATE notification_preferences SET activity_level='all',muted=$2 WHERE user_id=$1",
      [f.member.userId, { new_message: true }],
    );
    await pushMessage(f);
    assert.equal(await dispatch(), 0);
    await query(
      "UPDATE notification_preferences SET muted=$2 WHERE user_id=$1",
      [f.member.userId, {}],
    );
    await query(
      "INSERT INTO room_member_preferences(room_id,user_id,muted) VALUES($1,$2,TRUE)",
      [f.id, f.member.userId],
    );
    await pushMessage(f);
    assert.equal(await dispatch(), 0);
    await query(
      "UPDATE room_member_preferences SET muted=FALSE WHERE room_id=$1 AND user_id=$2",
      [f.id, f.member.userId],
    );
    const blocked = await pushMessage(f);
    await query(
      "INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2)",
      [f.member.userId, f.owner.userId],
    );
    assert.equal(await dispatch(), 0);
    const bell = (await request("/notifications", f.member.token)).body.data;
    assert.ok(!bell.notifications.some((n) => n.reference_id === blocked.id));
    await query(
      "DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2",
      [f.member.userId, f.owner.userId],
    );
    const active = await pushMessage(f);
    const peer = await open(f.member.token);
    await ack(peer, "join-room", { roomId: f.id });
    await ack(peer, "heartbeat", {
      foreground: true,
      roomId: f.id,
      revision: 1,
    });
    assert.equal(await dispatch(), 0);
    await ack(peer, "heartbeat", {
      foreground: false,
      roomId: null,
      revision: 2,
    });
    await pushMessage(f);
    assert.equal(await dispatch(), 1);
    await query(
      "UPDATE notification_preferences SET push_enabled=FALSE WHERE user_id=$1",
      [f.member.userId],
    );
    await pushMessage(f);
    assert.equal(await dispatch(), 0);
  }));

test("push renewal rotates its token, preserves pending jobs and logout revokes subscriptions", async () =>
  pushFixture(async (f) => {
    await pushMessage(f);
    const next = {
      ...f.subscription,
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    };
    const push = require("../src/services/push.service");
    const renewed = await push.renew(f.registration.renewalToken, next);
    assert.equal(renewed.bindingId, f.registration.bindingId);
    await assert.rejects(
      push.renew(f.registration.renewalToken, next),
      (error) => error.status === 401,
    );
    assert.equal(
      (
        await query(
          "SELECT COUNT(*)::int AS n FROM push_jobs WHERE subscription_id=$1",
          [renewed.subscriptionId],
        )
      ).rows[0].n,
      1,
    );
    let calls = 0;
    await push.dispatch(100, async () => {
      calls++;
    });
    assert.equal(calls, 1);
    assert.equal(
      (
        await request("/auth/logout", null, "POST", {
          refreshToken: f.member.refreshToken,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await query(
          "SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id=$1",
          [f.member.userId],
        )
      ).rows[0].n,
      0,
    );
    await assert.rejects(
      push.renew(renewed.renewalToken, next),
      (error) => error.status === 401,
    );
  }));

test("privacy hides photos/about/activity and DM reads across API and realtime", async () => {
  const owner = await account(),
    member = await account();
  const id = await room(owner, member, "dm");
  await query(
    "UPDATE users SET avatar_url='https://example.test/private-photo.png',bio='Private about',last_active_at=NOW() WHERE id=$1",
    [owner.userId],
  );
  const peer = await open(member.token, 1);
  await ack(peer, "join-room", { roomId: id });
  const changed = await request("/security/privacy", owner.token, "PATCH", {
    photo_visibility: "nobody",
    about_visibility: "nobody",
    online_visibility: "nobody",
    last_seen_visibility: "nobody",
    read_receipts: false,
  });
  assert.equal(changed.status, 200);
  const info = (await request(`/rooms/${id}`, member.token)).body.data;
  assert.equal(
    info.members.find((u) => u.id === owner.userId).avatar_url,
    null,
  );
  assert.equal(info.members.find((u) => u.id === owner.userId).bio, null);
  const self = (await request(`/rooms/${id}`, owner.token)).body.data;
  assert.equal(
    self.members.find((u) => u.id === owner.userId).bio,
    "Private about",
  );
  const snapshot = event(peer, "room-presence");
  await presence.publishRoomPresence(servers[0].io, id);
  const roster = await snapshot;
  assert.ok(roster.hiddenUserIds.includes(owner.userId));
  assert.ok(!roster.lastSeen[owner.userId]);
  const sent = await request("/messages", member.token, "POST", {
    roomId: id,
    content: "Privacy read receipt",
  });
  assert.equal(sent.status, 201);
  await request(`/rooms/${id}/seen`, owner.token, "POST");
  const receipt = (
    await request(`/messages/${sent.body.data.id}/receipts`, member.token)
  ).body.data;
  assert.equal(receipt.summary.reads_visible, false);
  assert.equal(receipt.summary.read_count, 0);
  assert.equal(receipt.recipients[0].read_at, null);
  assert.equal(
    (
      await query(
        "SELECT read FROM message_recipients WHERE message_id=$1 AND recipient_id=$2",
        [sent.body.data.id, owner.userId],
      )
    ).rows[0].read,
    true,
  );
  const delivered = event(peer, "message-delivered");
  await require("../src/services/messageReceipt.service").acknowledge({
    roomId: id,
    userId: owner.userId,
    messageId: sent.body.data.id,
    read: false,
    io: servers[0].io,
  });
  const notice = await delivered;
  assert.equal(notice.lastSeenAt, undefined);
  assert.equal(notice.lastSeenSequence, undefined);
});

test("unknown senders get one request, only its recipient can accept, and blocks prevent subsequent sends", async () => {
  const owner = await account(),
    member = await account(),
    outsider = await account();
  const id = await room(owner, member, "dm");
  await query(
    "INSERT INTO dm_requests(room_id,sender_id,recipient_id) VALUES($1,$2,$3)",
    [id, owner.userId, member.userId],
  );
  assert.equal(
    (
      await request("/messages", owner.token, "POST", {
        roomId: id,
        content: "First request",
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await request("/messages", owner.token, "POST", {
        roomId: id,
        content: "Second request",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/security/requests/${id}`, outsider.token, "POST", {
        status: "accepted",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/security/requests/${id}`, member.token, "POST", {
        status: "accepted",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/messages", member.token, "POST", {
        roomId: id,
        content: "Accepted reply",
      })
    ).status,
    201,
  );
  assert.equal(
    (await request(`/users/${owner.userId}/block`, member.token, "POST"))
      .status,
    200,
  );
  assert.equal(
    (
      await request("/messages", owner.token, "POST", {
        roomId: id,
        content: "Blocked reply",
      })
    ).status,
    403,
  );
  await request("/security/privacy", outsider.token, "PATCH", {
    dm_policy: "nobody",
  });
  assert.equal(
    (
      await request("/rooms", owner.token, "POST", {
        type: "dm",
        memberIds: [outsider.userId],
      })
    ).status,
    403,
  );
});

test("email links are single-use, password recovery revokes all devices and never returns tokens", async () => {
  const security = require("../src/services/accountSecurity.service");
  const account1 = await account(),
    other = await session(account1.userId);
  const email = (
    await query("SELECT email FROM users WHERE id=$1", [account1.userId])
  ).rows[0].email;
  const messages = [];
  const send = async (mail) => {
    messages.push(mail);
  };
  const known = await security.requestToken(email, "verify_email", { send }),
    unknown = await security.requestToken(
      "missing@example.test",
      "verify_email",
      { send },
    );
  assert.deepEqual(known, unknown);
  const token = () =>
    new URL(messages.at(-1).text.match(/https?:\/\/[^\s]+/)[0]).hash.slice(7);
  const verify = token();
  await security.redeem(verify, "verify_email", null, servers[0].io);
  assert.ok(
    (
      await query("SELECT email_verified_at FROM users WHERE id=$1", [
        account1.userId,
      ])
    ).rows[0].email_verified_at,
  );
  await assert.rejects(
    security.redeem(verify, "verify_email", null, servers[0].io),
    (e) => e.status === 400,
  );
  await security.requestToken(email, "reset_password", { send });
  const reset = token();
  const socket = await open(other.token, 1);
  const revoked = event(socket, "session:revoked");
  await security.redeem(
    reset,
    "reset_password",
    "A new secure password 2026!",
    servers[0].io,
  );
  await revoked;
  assert.equal((await request("/users/me", account1.token)).status, 401);
  assert.equal((await request("/users/me", other.token)).status, 401);
  await assert.rejects(
    security.redeem(
      reset,
      "reset_password",
      "Another secure password!",
      servers[0].io,
    ),
    (e) => e.status === 400,
  );
  const stored = (
    await query("SELECT token_hash FROM account_tokens WHERE user_id=$1", [
      account1.userId,
    ])
  ).rows;
  assert.ok(
    stored.every(
      (row) => row.token_hash !== verify && row.token_hash !== reset,
    ),
  );
});

test("device management requires password confirmation and evicts the selected session on another instance", async () => {
  const a = await account(),
    other = await session(a.userId),
    stranger = await account();
  await query("UPDATE users SET password_hash=$2 WHERE id=$1", [
    a.userId,
    await require("bcrypt").hash("Known secure password!", 4),
  ]);
  const socket = await open(other.token, 1);
  const list = await request("/security/sessions", a.token);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.sessions.filter((s) => s.current).length, 1);
  assert.equal(
    (
      await request(
        `/security/sessions/${other.sessionId}`,
        a.token,
        "DELETE",
        { password: "wrong" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        `/security/sessions/${stranger.sessionId}`,
        a.token,
        "DELETE",
        { password: "Known secure password!" },
      )
    ).status,
    404,
  );
  const revoked = event(socket, "session:revoked");
  assert.equal(
    (
      await request(
        `/security/sessions/${other.sessionId}`,
        a.token,
        "DELETE",
        { password: "Known secure password!" },
      )
    ).status,
    200,
  );
  await revoked;
  assert.equal((await request("/users/me", other.token)).status, 401);
  assert.equal((await request("/users/me", a.token)).status, 200);
});

async function cryptoFixture() {
  const protocol = await import("../../client/src/lib/cryptoProtocol.js");
  await protocol.ready;
  const a = await account(),
    b = await account();
  const av = protocol.createVault(a.userId),
    bv = protocol.createVault(b.userId);
  assert.equal(
    (
      await request(
        "/encryption/devices",
        a.token,
        "POST",
        protocol.publicDevice(av),
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/encryption/devices",
        b.token,
        "POST",
        protocol.publicDevice(bv),
      )
    ).status,
    201,
  );
  const created = await request("/rooms", a.token, "POST", {
    type: "dm",
    memberIds: [b.userId],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.encryption_mode, "e2ee-v1");
  const id = created.body.data.id;
  roomIds.push(id);
  assert.equal(
    (
      await request(`/security/requests/${id}`, b.token, "POST", {
        status: "accepted",
      })
    ).status,
    200,
  );
  return {
    protocol,
    a,
    b,
    av,
    bv,
    id,
    roster: (await request(`/encryption/rooms/${id}`, a.token)).body.data,
  };
}
test("encrypted messages round-trip through SQL with only ciphertext, reject plaintext/tampering, and keep retry identity", async () => {
  const { protocol, a, b, av, bv, id, roster } = await cryptoFixture();
  const clientId = randomUUID(),
    content = "Never server-readable caption";
  const encryptedPayload = protocol.sealMessage(av, roster, {
    roomId: id,
    clientId,
    content,
  });
  assert.equal(
    (await request("/messages", a.token, "POST", { roomId: id, content }))
      .status,
    400,
  );
  const sent = await request("/messages", a.token, "POST", {
    roomId: id,
    clientId,
    encryptedPayload,
  });
  assert.equal(sent.status, 201);
  const persisted = (
    await query("SELECT content,encrypted_payload FROM messages WHERE id=$1", [
      sent.body.data.id,
    ])
  ).rows[0];
  assert.equal(persisted.content, "[Encrypted message]");
  assert.ok(!JSON.stringify(persisted).includes(content));
  const fetched = (
    await request(`/messages/room/${id}?ids=${sent.body.data.id}`, b.token)
  ).body.data.messages[0];
  assert.equal(protocol.openMessage(bv, fetched).content, content);
  const retry = await request("/messages", a.token, "POST", {
    roomId: id,
    clientId,
    encryptedPayload,
  });
  assert.equal(retry.body.data.id, sent.body.data.id);
  const bad = {
    ...encryptedPayload,
    clientId: randomUUID(),
    signature: encryptedPayload.signature.slice(0, -4) + "AAAA",
  };
  assert.equal(
    (
      await request("/messages", a.token, "POST", {
        roomId: id,
        clientId: bad.clientId,
        encryptedPayload: bad,
      })
    ).status,
    400,
  );
  const edit = protocol.sealMessage(
    av,
    roster,
    { roomId: id, clientId, content: "Private edit" },
    { revision: 1 },
  );
  const edited = await request(
    `/messages/${sent.body.data.id}`,
    a.token,
    "PATCH",
    { encryptedPayload: edit },
  );
  assert.equal(edited.status, 200);
  assert.equal(
    protocol.openMessage(bv, edited.body.data).content,
    "Private edit",
  );
  assert.equal(
    (
      await request(`/messages/${sent.body.data.id}`, a.token, "PATCH", {
        content: "Plaintext edit",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/tasks", a.token, "POST", {
        roomId: id,
        title: "Leaking task",
      })
    ).status,
    409,
  );
  assert.equal(
    (await request(`/messages/room/${id}/search?q=secret`, b.token)).status,
    409,
  );
});

test("unapproved devices cannot receive new message keys, device links require signed approval, and backups stay encrypted", async () => {
  const { protocol, a, b, av, id } = await cryptoFixture();
  const pending = protocol.createVault(a.userId, false),
    newSession = await session(a.userId);
  const registered = await request(
    "/encryption/devices",
    newSession.token,
    "POST",
    protocol.publicDevice(pending),
  );
  assert.equal(registered.status, 201);
  assert.equal(registered.body.data.approved_at, null);
  let roster = (await request(`/encryption/rooms/${id}`, b.token)).body.data;
  assert.ok(!roster.devices.some((d) => d.id === pending.device.id));
  const pub = protocol.publicDevice(pending),
    approval = protocol.sealLink(av, {
      id: pub.id,
      box_key: pub.boxKey,
      signing_key: pub.signingKey,
    });
  assert.equal(
    (
      await request(
        `/encryption/devices/${pending.device.id}/approve`,
        a.token,
        "POST",
        { ...approval, signature: pub.boxKey },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        `/encryption/devices/${pending.device.id}/approve`,
        a.token,
        "POST",
        approval,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(`/encryption/devices/${pending.device.id}/link`, a.token))
      .status,
    404,
  );
  const linked = (
    await request(
      `/encryption/devices/${pending.device.id}/link`,
      newSession.token,
    )
  ).body.data;
  assert.equal(
    protocol.openLink(pending, linked.link_payload).identityKey,
    av.identityKey,
  );
  roster = (await request(`/encryption/rooms/${id}`, b.token)).body.data;
  assert.ok(roster.devices.some((d) => d.id === pending.device.id));
  const backup = protocol.sealBackup(av);
  assert.equal(
    (await request("/encryption/backup", a.token, "PUT", backup.payload))
      .status,
    200,
  );
  const stored = (await request("/encryption/backup", a.token)).body.data;
  assert.ok(!JSON.stringify(stored).includes(av.identitySecret));
  assert.equal(
    protocol.openBackup(a.userId, stored.payload, backup.recoveryKey)
      .identityKey,
    av.identityKey,
  );
  await request("/auth/logout", null, "POST", {
    refreshToken: newSession.refreshToken,
  });
  roster = (await request(`/encryption/rooms/${id}`, b.token)).body.data;
  assert.ok(!roster.devices.some((d) => d.id === pending.device.id));
});

test("legacy migration starts a separate encrypted timeline and an identity reset revokes other devices", async () => {
  const { protocol, a, b, av, bv } = await cryptoFixture();
  const legacy = await room(a, b, "dm");
  const old = (
    await request("/messages", a.token, "POST", {
      roomId: legacy,
      content: "Legacy history stays explicitly server-readable",
    })
  ).body.data;
  const upgrade = await request(
    `/encryption/rooms/${legacy}/upgrade`,
    a.token,
    "POST",
  );
  assert.equal(upgrade.status, 200);
  const target = upgrade.body.data.roomId;
  assert.notEqual(target, legacy);
  assert.equal(
    (await request(`/rooms/${target}`, b.token)).body.data.encryption_mode,
    "e2ee-v1",
  );
  assert.equal(
    (
      await request("/messages", a.token, "POST", {
        roomId: legacy,
        content: "Must use new conversation",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await query("SELECT encrypted_payload FROM messages WHERE id=$1", [
        old.id,
      ])
    ).rows[0].encrypted_payload,
    null,
  );
  await query("UPDATE users SET password_hash=$2 WHERE id=$1", [
    a.userId,
    await require("bcrypt").hash("Known secure reset password!", 4),
  ]);
  const other = await session(a.userId);
  const socket = await open(other.token, 1);
  const revoked = event(socket, "session:revoked");
  const replacement = protocol.createVault(a.userId);
  const reset = await request("/encryption/reset", a.token, "POST", {
    password: "Known secure reset password!",
    confirmation: "RESET ENCRYPTION",
    device: protocol.publicDevice(replacement),
  });
  assert.equal(reset.status, 200);
  await revoked;
  assert.equal((await request("/users/me", other.token)).status, 401);
  const roster = (await request(`/encryption/rooms/${target}`, b.token)).body
    .data;
  bv.identities[a.userId] = av.identityKey;
  assert.throws(
    () =>
      protocol.sealMessage(bv, roster, {
        roomId: target,
        clientId: randomUUID(),
        content: "Must reverify changed identity",
      }),
    /identity changed/,
  );
});

test("account mail is queued encrypted, retries provider failure, and clears token-bearing payload after delivery", async () => {
  const service = require("../src/services/accountSecurity.service"),
    env = require("../src/config/env"),
    old = env.mail;
  const user = await account(),
    email = (await query("SELECT email FROM users WHERE id=$1", [user.userId]))
      .rows[0].email;
  env.mail = {
    ...old,
    apiKey: "fixture-only",
    from: "Conclave <mail@example.test>",
    encryptionKey: randomBytes(32).toString("base64url"),
  };
  try {
    const result = await service.requestToken(email, "reset_password");
    assert.ok(!JSON.stringify(result).includes(email));
    const job = (
      await query(
        "SELECT j.* FROM account_mail_jobs j JOIN account_tokens t ON t.id=j.token_id WHERE t.user_id=$1",
        [user.userId],
      )
    ).rows[0];
    assert.ok(!JSON.stringify(job.encrypted_payload).includes(email));
    await service.dispatchMail(20, async () => {
      throw Object.assign(new Error("Resend temporarily unavailable"), {
        code: "ETIMEDOUT",
      });
    });
    assert.equal(
      (
        await query("SELECT completed_at FROM account_mail_jobs WHERE id=$1", [
          job.id,
        ])
      ).rows[0].completed_at,
      null,
    );
    await query(
      "UPDATE account_mail_jobs SET next_attempt_at=NOW() WHERE id=$1",
      [job.id],
    );
    let mail;
    await service.dispatchMail(20, async (value) => {
      mail = value;
    });
    assert.equal(mail.to, email);
    assert.ok(mail.text.includes("#token="));
    const done = (
      await query(
        "SELECT encrypted_payload,outcome FROM account_mail_jobs WHERE id=$1",
        [job.id],
      )
    ).rows[0];
    assert.deepEqual(done.encrypted_payload, {});
    assert.equal(done.outcome, "accepted");
  } finally {
    env.mail = old;
  }
});

test("a login checked before a concurrent password change cannot issue a session afterward", async () => {
  const bcrypt = require("bcrypt"),
    user = await account(),
    oldPassword = "Previous secure password!",
    newPassword = "Replacement secure password!";
  await query("UPDATE users SET password_hash=$2 WHERE id=$1", [
    user.userId,
    await bcrypt.hash(oldPassword, 4),
  ]);
  const email = (
    await query("SELECT email FROM users WHERE id=$1", [user.userId])
  ).rows[0].email;
  const count = Number(
    (
      await query("SELECT COUNT(*) FROM auth_sessions WHERE user_id=$1", [
        user.userId,
      ])
    ).rows[0].count,
  );
  const tx = await pool.connect();
  let login;
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [
      user.userId,
    ]);
    await tx.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
      user.userId,
      await bcrypt.hash(newPassword, 4),
    ]);
    login = request("/auth/login", null, "POST", {
      email,
      password: oldPassword,
    });
    let waiting = false;
    for (let i = 0; i < 200; i++) {
      waiting = Boolean(
        (
          await query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%WITH authorized AS%' AND pid<>pg_backend_pid() LIMIT 1",
          )
        ).rowCount,
      );
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(
      waiting,
      "login must reach the locked atomic session issuance gate",
    );
    await tx.query("COMMIT");
    assert.equal((await login).status, 401);
    assert.equal(
      Number(
        (
          await query("SELECT COUNT(*) FROM auth_sessions WHERE user_id=$1", [
            user.userId,
          ])
        ).rows[0].count,
      ),
      count,
    );
  } finally {
    await tx.query("ROLLBACK");
    tx.release();
    if (login) await login;
  }
});

test("durable session invalidation retries a failed cluster eviction after revocation commits", async () => {
  const user = await account(),
    peer = await open(user.token, 1),
    security = require("../src/services/accountSecurity.service"),
    sync = require("../src/services/sync.service");
  await query("UPDATE users SET password_hash=$2 WHERE id=$1", [
    user.userId,
    await require("bcrypt").hash("Remote logout recovery password!", 4),
  ]);
  const io = servers[0].io,
    original = io.serverSideEmitWithAck;
  io.serverSideEmitWithAck = async () => {
    throw new Error("Simulated peer outage");
  };
  try {
    await assert.rejects(
      security.revoke(
        user.userId,
        user.sessionId,
        user.sessionId,
        "Remote logout recovery password!",
        io,
      ),
      (error) => error.status === 503,
    );
  } finally {
    io.serverSideEmitWithAck = original;
  }
  assert.equal((await request("/users/me", user.token)).status, 401);
  assert.ok(
    (
      await query(
        "SELECT 1 FROM sync_changes WHERE kind='session' AND entity_id=$1 AND delivered_at IS NULL",
        [user.sessionId],
      )
    ).rowCount,
  );
  const revoked = event(peer, "session:revoked");
  await query(
    "UPDATE sync_changes SET next_attempt_at=NOW() WHERE delivered_at IS NULL",
  );
  await sync.dispatchChanges(io, 10000);
  await revoked;
  assert.ok(
    (
      await query(
        "SELECT 1 FROM sync_changes WHERE kind='session' AND entity_id=$1 AND delivered_at IS NOT NULL",
        [user.sessionId],
      )
    ).rowCount,
  );
});
