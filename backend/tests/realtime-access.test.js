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
process.env.SOCKET_REDIS_ADAPTER = "true";
process.env.BETA_MAX_TEAM_MEMBERS = "25";
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
    [id, `${id}@security.test`, "unused", `Security ${id}`],
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

async function createTeam(owner, label = "Lifecycle team") {
  const response = await request("/teams", owner.token, "POST", {
    name: `${label} ${randomBytes(4).toString("hex")}`,
    description: "Lifecycle coverage",
    creationKey: randomUUID(),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function acceptTeamInvite(owner, teamId, member, { emailBound = false } = {}) {
  const email = emailBound
    ? (await query("SELECT email FROM users WHERE id=$1", [member.userId])).rows[0].email
    : undefined;
  if (emailBound)
    await query("UPDATE users SET email_verified_at=NOW() WHERE id=$1", [member.userId]);
  const invitation = await request(`/teams/${teamId}/invites`, owner.token, "POST", {
    ...(email ? { email } : {}),
    maxUses: 1,
  });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const accepted = await request("/teams/invites/accept", member.token, "POST", {
    token: invitation.body.data.token,
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { invitation: invitation.body.data, accepted: accepted.body.data };
}

async function startInstance(port = 0) {
  const http = require("node:http").createServer(app);
  const io = new Server(http);
  const pub = redisClient.duplicate();
  const sub = redisClient.duplicate();
  await Promise.all([pub.connect(), sub.connect()]);
  redisPeers.push(pub, sub);
  io.adapter(createAdapter(pub, sub, { key: `${database}:cluster`, requestsTimeout: 10000 }));
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

test("push delivery retries transient failure, previews by default, groups by room and expires dead subscriptions", async () =>
  pushFixture(async (f) => {
    const message = await pushMessage(f, "Can you review the draft?");
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
    // push_preview_enabled defaults to TRUE: the recipient's name/room and a
    // truncated preview are included, grouped under one tag per conversation
    // so a later message in the same room updates this notification instead
    // of stacking a new one.
    await f.push.dispatch(100, async (sub, payload) => {
      const data = JSON.parse(payload);
      assert.equal(data.bindingId, f.registration.bindingId);
      assert.ok(payload.includes(message.content));
      assert.equal(data.tag, `conclave:room:${f.id}`);
      assert.equal(data.url, "/notifications");
      assert.match(data.actionToken, /^[A-Za-z0-9_-]{43}$/);
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
    // Opting out of previews restores the fully generic payload.
    await query(
      `INSERT INTO notification_preferences(user_id,push_preview_enabled) VALUES($1,FALSE)
       ON CONFLICT(user_id) DO UPDATE SET push_preview_enabled=FALSE`,
      [f.member.userId],
    );
    const generic = await pushMessage(f, "Private text never put in push");
    await f.push.dispatch(100, async (sub, payload) => {
      const data = JSON.parse(payload);
      assert.equal(data.title, "Conclave");
      assert.equal(data.body, "You have new activity in Conclave");
      assert.ok(!payload.includes(generic.content));
      // Grouping still holds with previews off: the conversation-kind tag is
      // what collapses the stack, independent of what the body says.
      assert.equal(data.tag, `conclave:room:${f.id}:new_message`);
      assert.match(data.actionToken, /^[A-Za-z0-9_-]{43}$/);
      calls++;
    });
    assert.equal(calls, 3);
    await query(
      "UPDATE notification_preferences SET push_preview_enabled=TRUE WHERE user_id=$1",
      [f.member.userId],
    );
    // The row now exists (inserted above), so this UPDATE affects it.
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

test("declined message requests can be undone briefly or accepted later, while blocks prevent recontact", async () => {
  const sender = await account();
  const recipient = await account();
  const id = await room(sender, recipient, "dm");
  await query(
    "INSERT INTO dm_requests(room_id,sender_id,recipient_id) VALUES($1,$2,$3)",
    [id, sender.userId, recipient.userId],
  );

  assert.equal(
    (await request(`/security/requests/${id}`, recipient.token, "POST", { status: "declined" })).status,
    200,
  );
  let listed = await request("/security/requests", recipient.token);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.requests[0].status, "declined");
  assert.ok(listed.body.data.requests[0].declined_at);
  assert.equal(
    (await request("/messages", sender.token, "POST", { roomId: id, content: "Again" })).status,
    403,
  );
  assert.equal(
    (await request("/rooms", sender.token, "POST", { type: "dm", memberIds: [recipient.userId] })).status,
    403,
  );
  assert.equal(
    (await query(
      "SELECT COUNT(*)::int AS count FROM dm_requests WHERE sender_id=$1 AND recipient_id=$2",
      [sender.userId, recipient.userId],
    )).rows[0].count,
    1,
  );

  assert.equal(
    (await request(`/security/requests/${id}`, recipient.token, "POST", { status: "undo_decline" })).status,
    200,
  );
  assert.equal(
    (await query("SELECT status,declined_at FROM dm_requests WHERE room_id=$1", [id])).rows[0].status,
    "pending",
  );

  await request(`/security/requests/${id}`, recipient.token, "POST", { status: "declined" });
  await query("UPDATE dm_requests SET declined_at=NOW()-INTERVAL '11 seconds' WHERE room_id=$1", [id]);
  assert.equal(
    (await request(`/security/requests/${id}`, recipient.token, "POST", { status: "undo_decline" })).status,
    409,
  );
  listed = await request("/security/requests", recipient.token);
  assert.equal(listed.body.data.requests[0].status, "declined");
  assert.equal(
    (await request(`/security/requests/${id}`, recipient.token, "POST", { status: "accepted" })).status,
    200,
  );
  assert.equal(
    (await request("/messages", sender.token, "POST", { roomId: id, content: "Accepted later" })).status,
    201,
  );

  const blockedSender = await account();
  const blockedRecipient = await account();
  const blockedRoom = await room(blockedSender, blockedRecipient, "dm");
  await query(
    "INSERT INTO dm_requests(room_id,sender_id,recipient_id) VALUES($1,$2,$3)",
    [blockedRoom, blockedSender.userId, blockedRecipient.userId],
  );
  assert.equal(
    (await request(`/users/${blockedSender.userId}/report`, blockedRecipient.token, "POST", {
      reason: "spam",
      details: "Unwanted message request",
      roomId: blockedRoom,
    })).status,
    201,
  );
  assert.equal(
    (await request(`/users/${blockedSender.userId}/block`, blockedRecipient.token, "POST")).status,
    200,
  );
  assert.equal(
    (await request("/security/requests", blockedRecipient.token)).body.data.requests.some((item) => item.room_id === blockedRoom),
    false,
  );
  assert.equal(
    (await request(`/security/requests/${blockedRoom}`, blockedRecipient.token, "POST", { status: "accepted" })).status,
    403,
  );
});

test("blocking while a message request is accepted cannot reopen a path to contact", async () => {
  const sender = await account();
  const recipient = await account();
  const id = await room(sender, recipient, "dm");
  await query(
    "INSERT INTO dm_requests(room_id,sender_id,recipient_id) VALUES($1,$2,$3)",
    [id, sender.userId, recipient.userId],
  );

  const [accept, block] = await Promise.all([
    request(`/security/requests/${id}`, recipient.token, "POST", {
      status: "accepted",
    }),
    request(`/users/${sender.userId}/block`, recipient.token, "POST"),
  ]);
  assert.ok([200, 403].includes(accept.status));
  assert.equal(block.status, 200);
  assert.equal(
    (
      await query(
        "SELECT 1 FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2",
        [recipient.userId, sender.userId],
      )
    ).rowCount,
    1,
  );
  const requestState = (
    await query("SELECT status FROM dm_requests WHERE room_id=$1", [id])
  ).rows[0].status;
  assert.ok(["pending", "accepted"].includes(requestState));
  assert.equal(
    (
      await request("/messages", sender.token, "POST", {
        roomId: id,
        clientId: randomUUID(),
        content: "This must remain blocked",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/rooms", sender.token, "POST", {
        type: "dm",
        memberIds: [recipient.userId],
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

test("plain messages send, edit, and search without E2EE columns", async () => {
  const owner = await account();
  const member = await account();
  const roomId = await room(owner, member);
  const sent = await request("/messages", owner.token, "POST", {
    roomId, clientId: randomUUID(), content: "Cutover searchable message",
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.data.content, "Cutover searchable message");
  const messageId = sent.body.data.id;
  const edited = await request(`/messages/${messageId}`, owner.token, "PATCH", { content: "Cutover edited message" });
  assert.equal(edited.status, 200);
  const search = await request(`/messages/room/${roomId}/search?q=Cutover`, member.token);
  assert.equal(search.status, 200);
  assert.ok(search.body.data.messages.some((message) => message.id === messageId));
  const ciphertext = await request("/messages", owner.token, "POST", {
    roomId, clientId: randomUUID(), encryptedPayload: { ciphertext: "opaque" },
  });
  assert.equal(ciphertext.status, 400);
});

test("teams and rooms work after message encryption removal", async () => {
  const owner = await account();
  const input = { name: "Cutover team", description: "Normal team", creationKey: randomUUID() };
  const created = await request("/teams", owner.token, "POST", input);
  assert.equal(created.status, 201);
  const teamId = created.body.data.id;
  const retry = await request("/teams", owner.token, "POST", input);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.data.id, teamId);
  const detail = await request(`/teams/${teamId}`, owner.token);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.team.name, input.name);
  const room = await request(`/teams/${teamId}/rooms`, owner.token, "POST", { name: "Planning", type: "group" });
  assert.equal(room.status, 201);
  const project = await request(`/teams/${teamId}/projects`, owner.token, "POST", { name: "Project", roomIds: [room.body.data.id] });
  assert.equal(project.status, 201);
  const rejected = await request("/teams", owner.token, "POST", { ...input, creationKey: randomUUID(), encryptionMode: "e2ee-v2" });
  assert.equal(rejected.status, 400);
});

test("team creation is idempotent and rejects reuse with different input", async () => {
  const owner = await account();
  const creationKey = randomUUID();
  const input = { name: "Idempotent team", description: "First request", creationKey };
  const [first, retry] = await Promise.all([
    request("/teams", owner.token, "POST", input),
    request("/teams", owner.token, "POST", input),
  ]);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.equal(first.body.data.id, retry.body.data.id);
  assert.equal((await query("SELECT count(*)::int AS count FROM teams WHERE created_by=$1 AND creation_key=$2", [owner.userId, creationKey])).rows[0].count, 1);
  const member = await account();
  await acceptTeamInvite(owner, first.body.data.id, member);
  const memberRoom = await request(`/teams/${first.body.data.id}/rooms`, member.token, "POST", {
    name: "Member-created room",
    type: "group",
  });
  assert.equal(memberRoom.status, 201, JSON.stringify(memberRoom.body));
  assert.equal((await query("SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2", [memberRoom.body.data.id, member.userId])).rows[0].role, "admin");
  assert.equal((await query("SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2", [first.body.data.id, member.userId])).rows[0].role, "member");
  const conflict = await request("/teams", owner.token, "POST", {
    ...input,
    name: "Different team",
  });
  assert.equal(conflict.status, 409);
});

test("team invitations enforce verification, binding, expiry, revocation, usage and concurrent acceptance", async () => {
  const owner = await account();
  const invited = await account();
  const other = await account();
  const team = await createTeam(owner, "Invitation team");
  const invitedEmail = (await query("SELECT email FROM users WHERE id=$1", [invited.userId])).rows[0].email;
  const bound = await request(`/teams/${team.id}/invites`, owner.token, "POST", { email: invitedEmail });
  assert.equal(bound.status, 201, JSON.stringify(bound.body));
  assert.equal((await request("/teams/invites/accept", invited.token, "POST", { token: bound.body.data.token })).status, 403);
  await query("UPDATE users SET email_verified_at=NOW() WHERE id=$1", [invited.userId]);
  assert.equal((await request("/teams/invites/accept", other.token, "POST", { token: bound.body.data.token })).status, 403);
  const concurrentSameUser = await Promise.all([
    request("/teams/invites/accept", invited.token, "POST", { token: bound.body.data.token }),
    request("/teams/invites/accept", invited.token, "POST", { token: bound.body.data.token }),
  ]);
  assert.ok(concurrentSameUser.every((response) => response.status === 200));
  assert.equal((await query("SELECT uses FROM team_invites WHERE id=$1", [bound.body.data.id])).rows[0].uses, 1);

  const expired = await request(`/teams/${team.id}/invites`, owner.token, "POST", { maxUses: 1 });
  await query("UPDATE team_invites SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [expired.body.data.id]);
  assert.equal((await request("/teams/invites/accept", other.token, "POST", { token: expired.body.data.token })).status, 404);

  const revoked = await request(`/teams/${team.id}/invites`, owner.token, "POST", { maxUses: 1 });
  assert.equal((await request(`/teams/${team.id}/invites/${revoked.body.data.id}`, owner.token, "DELETE")).status, 200);
  assert.equal((await request("/teams/invites/accept", other.token, "POST", { token: revoked.body.data.token })).status, 404);

  const oneUse = await request(`/teams/${team.id}/invites`, owner.token, "POST", { maxUses: 1 });
  const contenderA = await account();
  const contenderB = await account();
  const raced = await Promise.all([
    request("/teams/invites/accept", contenderA.token, "POST", { token: oneUse.body.data.token }),
    request("/teams/invites/accept", contenderB.token, "POST", { token: oneUse.body.data.token }),
  ]);
  assert.deepEqual(raced.map((response) => response.status).sort(), [200, 404]);
  assert.equal((await query("SELECT uses FROM team_invites WHERE id=$1", [oneUse.body.data.id])).rows[0].uses, 1);
});

test("public-room join requests require administrator review and grant only intended rooms", async () => {
  const owner = await account();
  const applicant = await account();
  const rejectedApplicant = await account();
  const team = await createTeam(owner, "Join request team");
  const publicRoom = await request(`/teams/${team.id}/rooms`, owner.token, "POST", { name: "Community", type: "public" });
  const privateRoom = await request(`/teams/${team.id}/rooms`, owner.token, "POST", { name: "Private", type: "group" });
  assert.equal(publicRoom.status, 201);
  assert.equal(privateRoom.status, 201);
  assert.equal((await request(`/teams/${team.id}/rooms/${publicRoom.body.data.id}/discovery`, owner.token, "PATCH", { discoverable: true })).status, 200);
  assert.equal((await request(`/teams/discovery-requests/${publicRoom.body.data.id}`, applicant.token, "POST")).status, 202);
  const detail = await request(`/teams/${team.id}`, owner.token);
  assert.ok(detail.body.data.requests.some((entry) => entry.user_id === applicant.userId));
  assert.equal((await request(`/teams/${team.id}/requests/${applicant.userId}`, owner.token, "POST", { decision: "approve" })).status, 200);
  assert.equal((await query("SELECT count(*)::int AS count FROM team_members WHERE team_id=$1 AND user_id=$2", [team.id, applicant.userId])).rows[0].count, 1);
  const memberships = (await query("SELECT room_id FROM room_members WHERE user_id=$1 AND room_id=ANY($2::uuid[])", [applicant.userId, [team.general_room_id, publicRoom.body.data.id, privateRoom.body.data.id]])).rows.map((row) => row.room_id);
  assert.ok(memberships.includes(team.general_room_id));
  assert.ok(memberships.includes(publicRoom.body.data.id));
  assert.ok(!memberships.includes(privateRoom.body.data.id));
  assert.equal((await request(`/teams/discovery-requests/${publicRoom.body.data.id}`, rejectedApplicant.token, "POST")).status, 202);
  assert.equal((await request(`/teams/${team.id}/requests/${rejectedApplicant.userId}`, owner.token, "POST", { decision: "reject" })).status, 200);
  assert.equal((await query("SELECT count(*)::int AS count FROM team_members WHERE team_id=$1 AND user_id=$2", [team.id, rejectedApplicant.userId])).rows[0].count, 0);
  assert.equal((await query("SELECT status FROM team_join_requests WHERE team_id=$1 AND user_id=$2", [team.id, rejectedApplicant.userId])).rows[0].status, "rejected");
});

test("ownership transfer preserves one owner and grants the new owner administration in every team room", async () => {
  const owner = await account();
  const successor = await account();
  const team = await createTeam(owner, "Transfer team");
  await acceptTeamInvite(owner, team.id, successor);
  const extraRoom = await request(`/teams/${team.id}/rooms`, owner.token, "POST", { name: "Operations", type: "group" });
  assert.equal(extraRoom.status, 201);
  assert.equal((await request("/messages",owner.token,"POST",{
    roomId:extraRoom.body.data.id,clientId:randomUUID(),content:"Before ownership transfer",
  })).status,201);
  const historyBoundary=(await query("SELECT message_sequence FROM rooms WHERE id=$1",[extraRoom.body.data.id])).rows[0].message_sequence;
  assert.equal((await request(`/teams/${team.id}/transfer-owner`, owner.token, "POST", { userId: successor.userId })).status, 200);
  const roles = await query("SELECT user_id,role FROM team_members WHERE team_id=$1 ORDER BY user_id", [team.id]);
  assert.equal(roles.rows.filter((row) => row.role === "owner").length, 1);
  assert.equal(roles.rows.find((row) => row.user_id === successor.userId).role, "owner");
  assert.equal(roles.rows.find((row) => row.user_id === owner.userId).role, "member");
  const grants = await query(`SELECT r.id,rm.role,rm.team_owner_grant FROM rooms r
    JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$2 WHERE r.team_id=$1`, [team.id, successor.userId]);
  assert.equal(grants.rowCount, 2);
  assert.ok(grants.rows.every((row) => row.role === "admin" && row.team_owner_grant));
  assert.equal((await query("SELECT owner_id FROM teams WHERE id=$1", [team.id])).rows[0].owner_id, successor.userId);
  const previousOwner = await query(`SELECT role,team_owner_grant FROM room_members
    WHERE room_id=$1 AND user_id=$2`, [team.general_room_id, owner.userId]);
  assert.deepEqual(previousOwner.rows[0], { role: "member", team_owner_grant: false });
  assert.equal((await query("SELECT history_start_sequence FROM room_members WHERE room_id=$1 AND user_id=$2",[extraRoom.body.data.id,successor.userId])).rows[0].history_start_sequence,historyBoundary);
  assert.equal((await query("SELECT count(*)::int AS count FROM team_audit_events WHERE team_id=$1 AND action='owner_transferred'", [team.id])).rows[0].count, 1);
  assert.equal((await request(`/teams/${team.id}/leave`, successor.token, "POST")).status, 409);
});

test("team database invariant rejects a missing or mismatched owner", async () => {
  const owner = await account();
  const nextMember = await account();
  const team = await createTeam(owner, "Owner invariant team");
  await acceptTeamInvite(owner, team.id, nextMember);
  assert.equal((await request("/users/me",owner.token,"DELETE")).status,409);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2", [team.id, owner.userId]);
    await assert.rejects(db.query("COMMIT"), (error) => error.code === "23514");
    await db.query("ROLLBACK");

    await db.query("BEGIN");
    await db.query("UPDATE teams SET owner_id=$2 WHERE id=$1", [team.id, nextMember.userId]);
    await assert.rejects(db.query("COMMIT"), (error) => error.code === "23514");
    await db.query("ROLLBACK");
  } finally {
    db.release();
  }
  const ownerRow = await query("SELECT owner_id FROM teams WHERE id=$1", [team.id]);
  assert.equal(ownerRow.rows[0].owner_id, owner.userId);
});

test("concurrent ownership transfers leave exactly one matching team owner", async () => {
  const owner = await account();
  const first = await account();
  const second = await account();
  const team = await createTeam(owner, "Transfer race team");
  await acceptTeamInvite(owner, team.id, first);
  await acceptTeamInvite(owner, team.id, second);
  const outcomes = await Promise.all([
    request(`/teams/${team.id}/transfer-owner`, owner.token, "POST", { userId: first.userId }),
    request(`/teams/${team.id}/transfer-owner`, owner.token, "POST", { userId: second.userId }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 200).length, 1);
  assert.equal(outcomes.filter((result) => [403,404,409].includes(result.status)).length, 1);
  const actual = await query(`SELECT t.owner_id,count(tm.user_id) FILTER(WHERE tm.role='owner')::int AS owners,
      count(tm.user_id) FILTER(WHERE tm.role='owner' AND tm.user_id=t.owner_id)::int AS matching
    FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE t.id=$1 GROUP BY t.id`, [team.id]);
  assert.equal(actual.rows[0].owners, 1);
  assert.equal(actual.rows[0].matching, 1);
  assert.ok([first.userId, second.userId].includes(actual.rows[0].owner_id));
});

test("operator owner recovery requires an active team admin and leaves an audit record", async () => {
  const owner=await account();
  const successor=await account();
  const team=await createTeam(owner,"Owner support team");
  await acceptTeamInvite(owner,team.id,successor);
  assert.equal((await request(`/teams/${team.id}/members/${successor.userId}`,owner.token,"PATCH",{role:"admin"})).status,200);
  const {execFileSync}=require("node:child_process");
  execFileSync(process.execPath,["scripts/recover-team-owner.js",
    "--team",team.id,"--new-owner",successor.userId,"--operator","beta-support@example.test",
    "--reason","Verified owner account recovery request","--confirm"],{
    cwd:require("node:path").join(__dirname,".."),
    env:process.env,
    stdio:"pipe",
  });
  assert.equal((await query("SELECT owner_id FROM teams WHERE id=$1",[team.id])).rows[0].owner_id,successor.userId);
  const audit=await query("SELECT actor_label,action,previous_owner_id,new_owner_id,reason FROM team_audit_events WHERE team_id=$1",[team.id]);
  assert.deepEqual(audit.rows[0],{
    actor_label:"beta-support@example.test",action:"owner_recovered",
    previous_owner_id:owner.userId,new_owner_id:successor.userId,
    reason:"Verified owner account recovery request",
  });
});

test("team removal immediately revokes API and socket access on every server", async () => {
  const owner = await account();
  const member = await account();
  const secondSession = await session(member.userId);
  const team = await createTeam(owner, "Removal team");
  await acceptTeamInvite(owner, team.id, member);
  assert.equal((await request(`/teams/${team.id}/members/${member.userId}`, owner.token, "PATCH", { role: "admin" })).status, 200);
  const memberInvite = await request(`/teams/${team.id}/invites`, member.token, "POST", { maxUses: 1 });
  assert.equal(memberInvite.status, 201);
  const assignedTask = await request("/tasks", owner.token, "POST", {
    roomId: team.general_room_id,
    clientId: randomUUID(),
    title: "Reassign after member removal",
    assigneeId: member.userId,
  });
  assert.equal(assignedTask.status, 201);
  await query("INSERT INTO team_pending_room_grants(team_id,user_id,room_id) VALUES($1,$2,$3)", [team.id, member.userId, team.general_room_id]);
  const a = await open(member.token, 0);
  const b = await open(secondSession.token, 1);
  for (const socket of [a, b]) assert.equal((await ack(socket, "join-room", { roomId: team.general_room_id })).ok, true);
  const resyncA = event(a, "room:resync");
  const resyncB = event(b, "room:resync");
  const removed = await request(`/teams/${team.id}/members/${member.userId}`, owner.token, "DELETE");
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await resyncA).roomId, team.general_room_id);
  assert.equal((await resyncB).roomId, team.general_room_id);
  const revokedHistory = await request(`/messages/room/${team.general_room_id}`, member.token);
  assert.ok([403, 404].includes(revokedHistory.status), "removed members cannot read room history");
  assert.ok([403, 404].includes((await ack(a, "join-room", { roomId: team.general_room_id })).status));
  assert.ok([403, 404].includes((await ack(b, "send-message", { roomId: team.general_room_id, content: "revoked" })).status));
  // Both active sessions must have lost the room locally; the adapter's
  // cross-node revocation acknowledgement above is the cluster-wide proof.
  for (const socket of [a, b])
    assert.equal(socket.connected, true, "revocation removes room access without ending the session");
  assert.equal((await query("SELECT assignee_id FROM tasks WHERE id=$1", [assignedTask.body.data.id])).rows[0].assignee_id, null);
  assert.equal((await query("SELECT revoked_at FROM team_invites WHERE id=$1", [memberInvite.body.data.id])).rows[0].revoked_at === null, false);
  assert.equal((await query("SELECT 1 FROM team_pending_room_grants WHERE team_id=$1 AND user_id=$2", [team.id, member.userId])).rowCount, 0);
});

test("self-leave clears membership, assignments and invitation capabilities and revokes every session", async () => {
  const owner = await account();
  const member = await account();
  const secondSession = await session(member.userId);
  const team = await createTeam(owner, "Self leave team");
  await acceptTeamInvite(owner, team.id, member);
  assert.equal((await request(`/teams/${team.id}/members/${member.userId}`, owner.token, "PATCH", { role: "admin" })).status, 200);
  const invite = await request(`/teams/${team.id}/invites`, member.token, "POST", { maxUses: 1 });
  assert.equal(invite.status, 201);
  const task = await request("/tasks", owner.token, "POST", {
    roomId: team.general_room_id,
    clientId: randomUUID(),
    title: "Clear departing assignee",
    assigneeId: member.userId,
  });
  assert.equal(task.status, 201);
  await query("INSERT INTO team_pending_room_grants(team_id,user_id,room_id) VALUES($1,$2,$3)", [team.id, member.userId, team.general_room_id]);
  const a = await open(member.token, 0);
  const b = await open(secondSession.token, 1);
  for (const socket of [a,b]) assert.equal((await ack(socket,"join-room",{roomId:team.general_room_id})).ok,true);
  const removedA=event(a,"room:resync"),removedB=event(b,"room:resync");
  const left=await request(`/teams/${team.id}/leave`,member.token,"POST");
  assert.equal(left.status,200,JSON.stringify(left.body));
  assert.equal((await removedA).roomId,team.general_room_id);
  assert.equal((await removedB).roomId,team.general_room_id);
  assert.equal((await query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2",[team.id,member.userId])).rowCount,0);
  assert.equal((await request(`/messages/room/${team.general_room_id}`,member.token)).status,403);
  assert.equal((await ack(a,"join-room",{roomId:team.general_room_id})).status,403);
  assert.equal((await query("SELECT assignee_id FROM tasks WHERE id=$1",[task.body.data.id])).rows[0].assignee_id,null);
  assert.equal((await query("SELECT revoked_at FROM team_invites WHERE id=$1",[invite.body.data.id])).rows[0].revoked_at===null,false);
  assert.equal((await query("SELECT 1 FROM team_pending_room_grants WHERE team_id=$1 AND user_id=$2",[team.id,member.userId])).rowCount,0);
  for(const socket of [a,b]) assert.equal(socket.connected,true,"leaving removes room access without ending the session");
});

test("team invite capacity respects the beta member cap", async () => {
  const owner=await account();
  const team=await createTeam(owner,"Capped team");
  const invite=await request(`/teams/${team.id}/invites`,owner.token,"POST",{maxUses:100});
  assert.equal(invite.status,201);
  assert.equal(invite.body.data.max_uses,24);
  const fillers=[];
  for(let index=0;index<24;index++) fillers.push(await account());
  for(const filler of fillers) await query("INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')",[team.id,filler.userId]);
  const newcomer=await account();
  assert.equal((await request("/teams/invites/accept",newcomer.token,"POST",{token:invite.body.data.token})).status,409);
  assert.equal((await query("SELECT uses FROM team_invites WHERE id=$1",[invite.body.data.id])).rows[0].uses,0);
});

test("team archive blocks mutations and restoration resumes authorized work", async () => {
  const owner = await account();
  const team = await createTeam(owner, "Archive team");
  const roomResponse = await request(`/teams/${team.id}/rooms`, owner.token, "POST", { name: "Delivery", type: "group" });
  const roomId = roomResponse.body.data.id;
  const project = await request(`/teams/${team.id}/projects`, owner.token, "POST", { name: "Release", roomIds: [roomId] });
  assert.equal(project.status, 201);
  assert.equal((await request(`/teams/${team.id}/archive`, owner.token, "POST")).status, 200);
  assert.equal((await request(`/teams/${team.id}`, owner.token)).status, 200);
  assert.equal((await request(`/teams/${team.id}/rooms`, owner.token, "POST", { name: "Blocked", type: "group" })).status, 409);
  assert.equal((await request(`/teams/${team.id}/projects`, owner.token, "POST", { name: "Blocked project", roomIds: [roomId] })).status, 409);
  assert.equal((await request("/messages", owner.token, "POST", { roomId, clientId: randomUUID(), content: "blocked" })).status, 400);
  assert.equal((await request("/tasks", owner.token, "POST", { roomId, clientId: randomUUID(), title: "Blocked task" })).status, 400);
  assert.equal((await request("/decisions", owner.token, "POST", { roomId, clientId: randomUUID(), title: "Blocked decision", body: "Must not be recorded", tags: [] })).status, 400);
  assert.equal((await request(`/work/projects/${project.body.data.id}`, owner.token, "PATCH", { name: "Blocked rename", description: "", status: "active" })).status, 409);
  assert.equal((await request(`/work/projects/${project.body.data.id}/automations`, owner.token, "POST", { triggerKind: "decision_recorded" })).status, 409);
  assert.equal((await request(`/work/rooms/${roomId}/brief`, owner.token, "PUT", { body: "Blocked brief", version: null })).status, 409);
  assert.equal((await request(`/teams/${team.id}/restore`, owner.token, "POST")).status, 200);
  assert.equal((await request("/messages", owner.token, "POST", { roomId, clientId: randomUUID(), content: "restored" })).status, 201);
  assert.equal((await request(`/work/projects/${project.body.data.id}`, owner.token, "PATCH", { name: "Restored release", description: "", status: "active" })).status, 200);
});

test("moderation inbox denies ordinary users and room admins and audits private report review", async () => {
  const reporter = await account();
  const target = await account();
  const outsider = await account();
  const moderator = await account();
  await query("UPDATE users SET role_id=(SELECT id FROM roles WHERE name='moderator') WHERE id=$1", [moderator.userId]);
  const roomId = await room(reporter, target);
  const sent = await request("/messages", reporter.token, "POST", {
    roomId,
    clientId: randomUUID(),
    content: "Safety report bounded context",
  });
  assert.equal(sent.status, 201);
  const report = await request(`/users/${target.userId}/report`, reporter.token, "POST", {
    reason: "harassment",
    details: "Please review this conversation.",
    roomId,
  });
  assert.equal(report.status, 201);
  assert.equal((await request("/moderation/reports", reporter.token)).status, 403);
  assert.equal((await request("/moderation/reports", target.token)).status, 403);
  assert.equal((await request("/moderation/reports", outsider.token)).status, 403);
  assert.equal((await request("/moderation/storage", outsider.token)).status, 403);
  const listed = await request("/moderation/reports", moderator.token);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const storage = await request("/moderation/storage", moderator.token);
  assert.equal(storage.status, 200, JSON.stringify(storage.body));
  assert.equal(Number.isFinite(storage.body.data.usage.total_gb), true);
  const item = listed.body.data.reports.find((entry) => entry.id === report.body.data.id);
  assert.ok(item);
  assert.equal(Object.hasOwn(item, "reporter_id"), false);
  const detail = await request(`/moderation/reports/${report.body.data.id}`, moderator.token);
  assert.equal(detail.status, 200);
  assert.equal(Object.hasOwn(detail.body.data, "reporter_id"), false);
  assert.ok(detail.body.data.context.some((message) => message.id === sent.body.data.id));
  assert.ok(detail.body.data.audit.some((entry) => entry.action === "report_viewed"));

  const assignment = await request(`/moderation/reports/${report.body.data.id}/assignment`, moderator.token, "PATCH", {
    assignedTo: moderator.userId,
  });
  assert.equal(assignment.status, 200, JSON.stringify(assignment.body));

  const transitions = await Promise.all([
    request(`/moderation/reports/${report.body.data.id}`, moderator.token, "PATCH", {
      expectedStatus: "open", status: "reviewed", reason: "Evidence reviewed by moderator",
    }),
    request(`/moderation/reports/${report.body.data.id}`, moderator.token, "PATCH", {
      expectedStatus: "open", status: "dismissed", reason: "Evidence reviewed by moderator",
    }),
  ]);
  assert.deepEqual(transitions.map((response) => response.status).sort(), [200, 409]);
  const finalStatus = (await query("SELECT status FROM user_reports WHERE id=$1", [report.body.data.id])).rows[0].status;
  assert.ok(["reviewed", "dismissed"].includes(finalStatus));
  assert.equal((await query("SELECT count(*)::int AS count FROM moderation_audit WHERE report_id=$1 AND action='report_transition'", [report.body.data.id])).rows[0].count, 1);
});

test("beta signup cap and kill switch reject new accounts before creating them", async () => {
  const env = require("../src/config/env");
  const prior = { ...env.beta };
  try {
    const active = Number((await query("SELECT count(*)::int AS count FROM users WHERE deleted_at IS NULL")).rows[0].count);
    env.beta.maxActiveAccounts = active;
    env.beta.signupsEnabled = true;
    const capped = await request("/auth/register", null, "POST", {
      displayName: `Capped ${randomUUID()}`,
      email: `${randomUUID()}@signup.test`,
      password: "Safe signup passphrase 2026!",
      website: "",
    });
    assert.equal(capped.status, 403);
    assert.match(capped.body.message, /cohort is currently full/i);

    env.beta.maxActiveAccounts = active + 1;
    env.beta.signupsEnabled = false;
    const paused = await request("/auth/register", null, "POST", {
      displayName: `Paused ${randomUUID()}`,
      email: `${randomUUID()}@signup.test`,
      password: "Safe signup passphrase 2026!",
      website: "",
    });
    assert.equal(paused.status, 403);
    assert.match(paused.body.message, /registration is closed/i);
  } finally {
    Object.assign(env.beta, prior);
  }
});

test("push mark-read action acknowledges only its visible message boundary and is single-use", async () => {
  const sender = await account();
  const recipient = await account();
  const roomId = await room(sender, recipient);
  const earlier = await request("/messages", sender.token, "POST", {
    roomId,
    clientId: randomUUID(),
    content: "Earlier unread message",
  });
  assert.equal(earlier.status, 201, JSON.stringify(earlier.body));
  const sent = await request("/messages", sender.token, "POST", {
    roomId,
    clientId: randomUUID(),
    content: "Read this from the notification action",
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const messageId = sent.body.data.id;
  const notificationId = randomUUID();
  const subscriptionId = randomUUID();
  const bindingId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO push_subscriptions(id,user_id,session_id,endpoint,subscription,binding_id,renewal_hash)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,'test-renewal-hash')`,
    [subscriptionId, recipient.userId, recipient.sessionId,
      `https://fcm.googleapis.com/action-${subscriptionId}`,
      JSON.stringify({ endpoint: `https://fcm.googleapis.com/action-${subscriptionId}`, keys: { p256dh: "test", auth: "test" } }), bindingId],
  );
  await query(
    `INSERT INTO notifications(id,recipient_id,type,reference_id,actor_id)
     VALUES($1,$2,'new_message',$3,$4)`,
    [notificationId, recipient.userId, messageId, sender.userId],
  );
  await query(
    `INSERT INTO notification_action_tokens(token_hash,notification_id,message_id,user_id,session_id,subscription_id,binding_id,action,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'mark_read',NOW()+INTERVAL '10 minutes')`,
    [createHash("sha256").update(token).digest("hex"), notificationId, messageId,
      recipient.userId, recipient.sessionId, subscriptionId, bindingId],
  );

  const eligibility = await query(
    `SELECT n.seen,m.deleted_at,message_visible(m.id,$2) AS message_visible,
       EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=m.room_id AND rm.user_id=$2) AS member,
       s.revoked_at,s.expires_at>NOW() AS session_active,
       p.binding_id=$3 AS binding_matches,
       a.used_at,a.expires_at>NOW() AS action_active
     FROM notification_action_tokens a
     JOIN notifications n ON n.id=a.notification_id
     JOIN messages m ON m.id=a.message_id
     JOIN auth_sessions s ON s.id=a.session_id
     JOIN push_subscriptions p ON p.id=a.subscription_id
     WHERE a.token_hash=$1`,
    [createHash("sha256").update(token).digest("hex"), recipient.userId, bindingId],
  );
  assert.equal(eligibility.rowCount, 1, JSON.stringify(eligibility.rows));
  assert.equal(eligibility.rows[0].seen, false, JSON.stringify(eligibility.rows[0]));
  assert.equal(eligibility.rows[0].deleted_at, null, JSON.stringify(eligibility.rows[0]));
  assert.equal(eligibility.rows[0].message_visible, true, JSON.stringify(eligibility.rows[0]));
  assert.equal(eligibility.rows[0].member, true, JSON.stringify(eligibility.rows[0]));
  assert.equal(eligibility.rows[0].session_active, true, JSON.stringify(eligibility.rows[0]));
  assert.equal(eligibility.rows[0].binding_matches, true, JSON.stringify(eligibility.rows[0]));
  assert.equal(eligibility.rows[0].used_at, null, JSON.stringify(eligibility.rows[0]));
  assert.equal(eligibility.rows[0].action_active, true, JSON.stringify(eligibility.rows[0]));

  const action = await request("/push/actions/mark-read", null, "POST", { token });
  assert.equal(action.status, 200, JSON.stringify(action.body));
  assert.equal(action.body.data.markedRead, true);
  assert.equal((await query("SELECT seen FROM notifications WHERE id=$1", [notificationId])).rows[0].seen, true);
  assert.equal((await query("SELECT read FROM message_recipients WHERE message_id=$1 AND recipient_id=$2", [messageId, recipient.userId])).rows[0].read, true);
  assert.equal((await query("SELECT read FROM message_recipients WHERE message_id=$1 AND recipient_id=$2", [earlier.body.data.id, recipient.userId])).rows[0].read, true);
  assert.equal((await request("/push/actions/mark-read", null, "POST", { token })).status, 404);
});

test("account suspension revokes all sessions and restoration allows a fresh login", async () => {
  const moderator = await account();
  const target = await account();
  const password = "Moderation lifecycle passphrase 2026!";
  await query("UPDATE users SET role_id=(SELECT id FROM roles WHERE name='moderator') WHERE id=$1", [moderator.userId]);
  await query("UPDATE users SET password_hash=$2 WHERE id=$1", [target.userId, await require("bcrypt").hash(password, 4)]);
  const secondSession = await session(target.userId);
  const roomId = await room(moderator, target);
  const report = await request(`/users/${target.userId}/report`, moderator.token, "POST", {
    reason: "harassment",
    details: "Confirmed repeated abuse reports",
    roomId,
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  const assignment = await request(`/moderation/reports/${report.body.data.id}/assignment`, moderator.token, "PATCH", {
    assignedTo: moderator.userId,
  });
  assert.equal(assignment.status, 200, JSON.stringify(assignment.body));
  const firstSocket = await open(target.token, 0);
  const secondSocket = await open(secondSession.token, 1);
  for (const socket of [firstSocket, secondSocket])
    assert.equal((await ack(socket, "join-room", { roomId })).ok, true);

  assert.equal((await request(`/moderation/users/${target.userId}/suspend`, moderator.token, "POST", {
    reason: "Confirmed repeated abuse reports",
    reportId: report.body.data.id,
  })).status, 200);
  assert.equal((await request("/users/me", target.token)).status, 401);
  assert.equal((await request("/auth/refresh", null, "POST", { refreshToken: target.refreshToken })).status, 401);
  assert.equal((await request("/auth/login", null, "POST", {
    email: `${target.userId}@security.test`, password,
  })).status, 401);
  for (const socket of [firstSocket, secondSocket]) {
    assert.equal(socket.connected, false);
  }
  const audit = await query("SELECT action,reason FROM moderation_audit WHERE subject_user_id=$1 AND action='account_suspended'", [target.userId]);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].reason, "Confirmed repeated abuse reports");

  assert.equal((await request(`/moderation/users/${target.userId}/restore`, moderator.token, "POST", {
    reason: "Appeal reviewed; access restored",
    reportId: report.body.data.id,
  })).status, 200);
  const login = await request("/auth/login", null, "POST", { email: `${target.userId}@security.test`, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal((await request("/users/me", login.body.data.accessToken)).status, 200);
  assert.equal((await query("SELECT suspended_at FROM users WHERE id=$1", [target.userId])).rows[0].suspended_at, null);
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

test("phase6: approval keeps applicants outside history until an admin accepts", async () => {
  const a = await account(),
    b = await account(),
    c = await account(),
    id = await room(a, b, "public");
  assert.equal(
    (
      await request(`/rooms/${id}/settings`, b.token, "PATCH", {
        join_approval: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/rooms/${id}/settings`, a.token, "PATCH", {
        join_approval: true,
      })
    ).status,
    200,
  );
  const pending = await request(`/rooms/${id}/join`, c.token, "POST");
  assert.equal(pending.status, 200);
  assert.equal(pending.body.data.status, "pending");
  assert.equal((await request(`/rooms/${id}`, c.token)).status, 403);
  assert.equal((await request(`/messages/room/${id}`, c.token)).status, 403);
  assert.equal(
    (
      await request(`/rooms/${id}/requests/${c.userId}`, b.token, "POST", {
        decision: "approved",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/rooms/${id}/requests/${c.userId}`, a.token, "POST", {
        decision: "approved",
      })
    ).status,
    200,
  );
  assert.equal((await request(`/rooms/${id}`, c.token)).status, 200);
  const deletedApplicant = await account();
  assert.equal(
    (await request(`/rooms/${id}/join`, deletedApplicant.token, "POST")).body
      .data.status,
    "pending",
  );
  await query("UPDATE users SET deleted_at=NOW() WHERE id=$1", [
    deletedApplicant.userId,
  ]);
  assert.equal(
    (
      await request(
        `/rooms/${id}/requests/${deletedApplicant.userId}`,
        a.token,
        "POST",
        { decision: "approved" },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await query(
        "SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2",
        [id, deletedApplicant.userId],
      )
    ).rowCount,
    0,
  );
});
test("phase6: revocable bounded invitations serialize concurrent joins and pending approvals", async () => {
  const a = await account(),
    b = await account(),
    c = await account(),
    d = await account(),
    id = await room(a, b);
  assert.equal(
    (await request(`/rooms/${id}/invitations`, b.token, "POST", {})).status,
    403,
  );
  const invite = await request(`/rooms/${id}/invitations`, a.token, "POST", {
    maxUses: 1,
    expiresInHours: 1,
  });
  assert.equal(invite.status, 201);
  const token = invite.body.data.token;
  assert.ok(token);
  assert.equal(
    (
      await query("SELECT token_hash FROM room_invites WHERE id=$1", [
        invite.body.data.id,
      ])
    ).rows[0].token_hash,
    createHash("sha256").update(token).digest("hex"),
  );
  const results = await Promise.all(
    [c, d].map((u) =>
      request("/rooms/invitations/accept", u.token, "POST", { token }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 404).length, 1);
  const next = await request(`/rooms/${id}/invitations`, a.token, "POST", {});
  await request(`/rooms/${id}/settings`, a.token, "PATCH", {
    join_approval: true,
  });
  const outsider = await account();
  assert.equal(
    (
      await request("/rooms/invitations/accept", outsider.token, "POST", {
        token: next.body.data.token,
      })
    ).body.data.status,
    "pending",
  );
  assert.equal(
    (
      await request(
        `/rooms/${id}/invitations/${next.body.data.id}`,
        b.token,
        "DELETE",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        `/rooms/${id}/invitations/${next.body.data.id}`,
        a.token,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/rooms/${id}/requests/${outsider.userId}`,
        a.token,
        "POST",
        { decision: "approved" },
      )
    ).status,
    409,
  );
  assert.equal((await request(`/rooms/${id}`, outsider.token)).status, 403);
});
test("phase6: participant send/link permissions and atomic admin handover are enforced", async () => {
  const a = await account(),
    b = await account(),
    id = await room(a, b);
  await request(`/rooms/${id}/settings`, a.token, "PATCH", {
    member_can_send: false,
    member_can_invite: true,
  });
  assert.equal(
    (
      await request("/messages", b.token, "POST", {
        roomId: id,
        content: "not allowed",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/messages", a.token, "POST", {
        roomId: id,
        content: "admin announcement",
      })
    ).status,
    201,
  );
  assert.equal(
    (await request(`/rooms/${id}/invitations`, b.token, "POST", {})).status,
    201,
  );
  assert.equal(
    (
      await request(`/rooms/${id}/handover`, b.token, "POST", {
        successorId: a.userId,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/rooms/${id}/handover`, a.token, "POST", {
        successorId: b.userId,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await query(
        "SELECT COUNT(*)::int AS n FROM room_members WHERE room_id=$1 AND role='admin'",
        [id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await request(`/rooms/${id}/settings`, a.token, "PATCH", {
        member_can_send: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/rooms/${id}/settings`, b.token, "PATCH", {
        member_can_send: true,
      })
    ).status,
    200,
  );
});
test("phase6: personal clearing filters histories, links, media and snapshots without reading or deleting messages", async () => {
  const a = await account(),
    b = await account(),
    id = await room(a, b),
    second = await session(b.userId);
  const sent = (
    await request("/messages", a.token, "POST", {
      roomId: id,
      content: "Visible https://example.test/phase6",
    })
  ).body.data;
  assert.ok(sent.id);
  const aid = randomUUID();
  await query(
    "INSERT INTO attachments(id,message_id,filename,file_url,file_type,size_bytes) VALUES($1,$2,'test.txt','r2://fixture/phase6','text/plain',4)",
    [aid, sent.id],
  );
  assert.equal(
    (await request(`/rooms/${id}/links`, b.token)).body.data.messages.length,
    1,
  );
  assert.equal(
    (await request(`/messages/room/${id}/media?kind=documents`, b.token)).body
      .data.media.length,
    1,
  );
  assert.equal(
    (await request(`/rooms/${id}/clear`, b.token, "POST")).status,
    200,
  );
  const clearedRoom = (await request("/rooms", second.token)).body.data.find(
    (r) => r.id === id,
  );
  assert.equal(clearedRoom.last_message, null);
  assert.equal(clearedRoom.unread_count, 0);
  const mine = (await request(`/messages/room/${id}`, second.token)).body.data;
  assert.equal(mine.messages.length, 0);
  assert.equal(
    (await request(`/messages/room/${id}?ids=${sent.id}`, second.token)).body
      .data.missingIds[0],
    sent.id,
  );
  assert.equal(
    (await request(`/rooms/${id}/links`, second.token)).body.data.messages
      .length,
    0,
  );
  assert.equal(
    (await request(`/messages/room/${id}/media?kind=documents`, second.token))
      .body.data.media.length,
    0,
  );
  assert.equal(
    (await request(`/attachments/${aid}`, second.token)).status,
    404,
  );
  assert.equal(
    (await request(`/messages/room/${id}/search?q=Visible`, second.token)).body
      .data.messages.length,
    0,
  );
  assert.equal(
    (await request(`/messages/room/${id}`, a.token)).body.data.messages.length,
    1,
  );
  assert.equal(
    (
      await query(
        "SELECT read FROM message_recipients WHERE message_id=$1 AND recipient_id=$2",
        [sent.id, b.userId],
      )
    ).rows[0].read,
    false,
  );
  const later = await request("/messages", b.token, "POST", {
    roomId: id,
    clientId: randomUUID(),
    content: "Offline draft sent after clear",
  });
  assert.equal(later.status, 201);
  assert.equal(
    (await request(`/messages/room/${id}`, b.token)).body.data.messages.length,
    1,
  );
  const cleared = (await request(`/rooms/${id}`, b.token)).body.data
    .cleared_sequence;
  assert.ok(BigInt(cleared) > 0n);
  await request(`/rooms/${id}/members/${b.userId}`, b.token, "DELETE");
  await request(`/rooms/${id}/members`, a.token, "POST", { userId: b.userId });
  assert.equal(
    (await request(`/rooms/${id}`, b.token)).body.data.cleared_sequence,
    cleared,
  );
});
test("phase6: room preference patches compose across devices and private replay records clearing", async () => {
  const a = await account(),
    b = await account(),
    id = await room(a, b),
    other = await session(b.userId);
  await Promise.all([
    request(`/rooms/${id}/preferences`, b.token, "PATCH", { muted: true }),
    request(`/rooms/${id}/preferences`, other.token, "PATCH", { pinned: true }),
  ]);
  const state = (await request(`/rooms/${id}/management`, other.token)).body
    .data;
  assert.equal(state.preferences.muted, true);
  assert.equal(state.preferences.pinned, true);
  await request("/messages", a.token, "POST", {
    roomId: id,
    content: "clear me",
  });
  await request(`/rooms/${id}/clear`, b.token, "POST");
  assert.ok(
    (
      await query(
        "SELECT 1 FROM sync_changes WHERE room_id=$1 AND user_id=$2 AND kind='preferences' AND private",
        [id, b.userId],
      )
    ).rowCount,
  );
  assert.equal(
    (await request(`/rooms/${id}/management`, (await account()).token)).status,
    404,
  );
});

test("phase6: expired invitations disclose no room metadata and handover races keep an admin", async () => {
  const a = await account(),
    b = await account(),
    c = await account(),
    id = await room(a, b);
  const link = (await request(`/rooms/${id}/invitations`, a.token, "POST", {}))
    .body.data;
  await query(
    "UPDATE room_invites SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",
    [link.id],
  );
  const expired = await request("/rooms/invitations/accept", c.token, "POST", {
    token: link.token,
  });
  assert.equal(expired.status, 404);
  assert.ok(!JSON.stringify(expired.body).includes(id));
  const attempts = await Promise.all([
    request(`/rooms/${id}/handover`, a.token, "POST", {
      successorId: b.userId,
    }),
    request(`/rooms/${id}/members/${b.userId}`, a.token, "DELETE"),
  ]);
  assert.ok(attempts.some((result) => result.status === 200));
  assert.ok(
    (
      await query(
        "SELECT 1 FROM room_members WHERE room_id=$1 AND role='admin'",
        [id],
      )
    ).rowCount,
  );
});

test("phase6: pending invitation status survives refresh without silently resubmitting a rejected request", async () => {
  const a = await account(),
    b = await account(),
    c = await account(),
    id = await room(a, b);
  await request(`/rooms/${id}/settings`, a.token, "PATCH", {
    join_approval: true,
  });
  const token = (await request(`/rooms/${id}/invitations`, a.token, "POST", {}))
    .body.data.token;
  await request("/rooms/invitations/accept", c.token, "POST", { token });
  assert.equal(
    (await request("/rooms/invitations/status", c.token, "POST", { token }))
      .body.data.status,
    "pending",
  );
  await request(`/rooms/${id}/requests/${c.userId}`, a.token, "POST", {
    decision: "rejected",
  });
  assert.equal(
    (await request("/rooms/invitations/status", c.token, "POST", { token }))
      .body.data.status,
    "rejected",
  );
  assert.equal(
    (
      await query(
        "SELECT status FROM room_join_requests WHERE room_id=$1 AND user_id=$2",
        [id, c.userId],
      )
    ).rows[0].status,
    "rejected",
  );
});

test("phase6: shared links paginate without duplicates and reject malformed cursors", async () => {
  const a = await account(),
    b = await account(),
    id = await room(a, b);
  for (let i = 0; i < 27; i++) {
    await query(
      `WITH next AS (UPDATE rooms SET message_sequence=message_sequence+1 WHERE id=$1 RETURNING message_sequence) INSERT INTO messages(room_id,sender_id,room_sequence,content) SELECT $1,$2,message_sequence,$3 FROM next`,
      [id, a.userId, `Link https://example.test/page/${i}`],
    );
  }
  const first = await request(`/rooms/${id}/links`, b.token);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.messages.length, 25);
  assert.ok(first.body.data.nextCursor);
  const second = await request(
    `/rooms/${id}/links?before=${first.body.data.nextCursor}`,
    b.token,
  );
  assert.equal(second.body.data.messages.length, 2);
  assert.equal(second.body.data.nextCursor, null);
  assert.equal(
    new Set(
      [...first.body.data.messages, ...second.body.data.messages].map(
        (m) => m.id,
      ),
    ).size,
    27,
  );
  for (const cursor of ["9999999999999999999", "abc", "1&before=2"])
    assert.equal(
      (await request(`/rooms/${id}/links?before=${cursor}`, b.token)).status,
      400,
    );
  const outsider = await account();
  assert.equal(
    (await request(`/rooms/${id}/links`, outsider.token)).status,
    404,
  );
  await request(`/rooms/${id}/clear`, b.token, "POST");
  assert.equal(
    (await request(`/rooms/${id}/links`, b.token)).body.data.messages.length,
    0,
  );
  assert.equal(
    (await request(`/rooms/${id}/links`, a.token)).body.data.messages.length,
    25,
  );
});

test("phase6: active invitations stay manageable after many links are revoked", async () => {
  const a = await account(),
    b = await account(),
    id = await room(a, b);
  const active = randomUUID();
  await query(
    "INSERT INTO room_invites(id,room_id,token_hash,created_by,expires_at,max_uses,created_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '1 day',10,NOW()-INTERVAL '1 hour')",
    [active, id, randomUUID(), a.userId],
  );
  await query(
    "INSERT INTO room_invites(room_id,token_hash,created_by,expires_at,max_uses,revoked_at) SELECT $1,gen_random_uuid()::text,$2,NOW()+INTERVAL '1 day',10,NOW() FROM generate_series(1,60)",
    [id, a.userId],
  );
  const data = (await request(`/rooms/${id}/management`, a.token)).body.data;
  assert.equal(data.invites.length, 50);
  assert.equal(data.invites[0].id, active);
  assert.equal(
    (await request(`/rooms/${id}/invitations/${active}`, a.token, "DELETE"))
      .status,
    200,
  );
});

test("ux: expanded reactions accept catalog emoji and reject arbitrary text", async () => {
  const a = await account(),
    b = await account(),
    id = await room(a, b);
  const sent = (
    await request("/messages", a.token, "POST", {
      roomId: id,
      content: "React to this",
    })
  ).body.data;
  assert.equal(
    (
      await request(`/messages/${sent.id}/reactions`, b.token, "PUT", {
        emoji: "❤️",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/messages/${sent.id}/reactions`, b.token, "PUT", {
        emoji: "javascript:bad",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/messages/${sent.id}/reactions`, b.token, "PUT", {
        emoji: "🚀",
      })
    ).status,
    200,
  );
});
test("ux: threads paginate persisted replies, have unread positions, and enforce membership", async () => {
  const a = await account(),
    b = await account(),
    c = await account(),
    id = await room(a, b);
  const root = (
    await request("/messages", a.token, "POST", {
      roomId: id,
      content: "Root topic",
    })
  ).body.data;
  const reply = (
    await request("/messages", a.token, "POST", {
      roomId: id,
      threadRootId: root.id,
      replyToId: root.id,
      content: "Persistent reply",
    })
  ).body.data;
  assert.equal(reply.thread_root_id, root.id);
  const inbox = (await request("/experience/threads", b.token)).body.data;
  const topic = inbox.threads.find((t) => t.id === root.id);
  assert.equal(topic.reply_count, 1);
  assert.equal(topic.unread_count, 1);
  const page = (await request(`/experience/threads/${root.id}`, b.token)).body
    .data;
  assert.equal(page.messages.length, 2);
  assert.equal(
    (await request(`/experience/threads/${root.id}`, c.token)).status,
    404,
  );
  assert.equal(
    (
      await request(`/experience/threads/${root.id}/read`, b.token, "POST", {
        sequence: reply.room_sequence,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/experience/threads", b.token)).body.data.threads.find(
      (t) => t.id === root.id,
    ).unread_count,
    0,
  );
  assert.equal(
    (
      await request("/messages", b.token, "POST", {
        roomId: id,
        threadRootId: reply.id,
        content: "Nested invalid root",
      })
    ).status,
    404,
  );
});
test("ux: scheduled text publishes once across competing workers and respects cancellation", async () => {
  const a = await account(),
    b = await account(),
    id = await room(a, b),
    clientId = randomUUID();
  const created = await request("/experience/schedules", a.token, "POST", {
    roomId: id,
    payload: { roomId: id, clientId, content: "Durable schedule" },
    dueAt: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal(created.status, 200);
  const schedule = created.body.data;
  assert.equal(
    (await request(`/experience/schedules/${schedule.id}`, b.token, "DELETE"))
      .status,
    409,
  );
  await query(
    "UPDATE scheduled_messages SET due_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [schedule.id],
  );
  const worker = require("../src/services/experienceWorker.service");
  await Promise.all([worker.run(servers[0].io), worker.run(servers[1].io)]);
  assert.equal(
    (
      await query(
        "SELECT COUNT(*)::int AS n FROM messages WHERE room_id=$1 AND client_id=$2",
        [id, clientId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await query("SELECT status,payload FROM scheduled_messages WHERE id=$1", [
        schedule.id,
      ])
    ).rows[0].status,
    "sent",
  );
  const other = await request("/experience/schedules", a.token, "POST", {
    roomId: id,
    payload: {
      roomId: id,
      clientId: randomUUID(),
      content: "Cancelled schedule",
    },
    dueAt: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal(
    (
      await request(
        `/experience/schedules/${other.body.data.id}`,
        a.token,
        "DELETE",
      )
    ).status,
    200,
  );
  await worker.run();
  assert.equal(
    (
      await query(
        "SELECT 1 FROM messages WHERE room_id=$1 AND content='Cancelled schedule'",
        [id],
      )
    ).rowCount,
    0,
  );
});
test("ux: private saved notes cannot admit anyone else and bookmarks are personal", async () => {
  const a = await account(),
    b = await account(),
    id = await room(a, b);
  const personal = (await request("/experience/saved-room", a.token, "POST"))
    .body.data;
  assert.equal(
    (
      await request(`/rooms/${personal.id}/members`, a.token, "POST", {
        userId: b.userId,
      })
    ).status >= 400,
    true,
  );
  assert.equal((await request(`/rooms/${personal.id}`, b.token)).status, 403);
  assert.equal(
    (await request("/experience/saved-room", a.token, "POST")).body.data.id,
    personal.id,
  );
  const msg = (
    await request("/messages", a.token, "POST", {
      roomId: id,
      content: "Saved privately",
    })
  ).body.data;
  assert.equal(
    (
      await request(`/messages/${msg.id}/pin`, a.token, "PUT", {
        scope: "user",
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/experience/saved", a.token)).body.data.messages.length,
    1,
  );
  assert.equal(
    (await request("/experience/saved", b.token)).body.data.messages.length,
    0,
  );
  await request(`/rooms/${id}/clear`, a.token, "POST");
  assert.equal(
    (await request("/experience/saved", a.token)).body.data.messages.length,
    0,
  );
});
test("ux: reminders create a durable private notification exactly once", async () => {
  const a = await account(),
    b = await account(),
    id = await room(a, b);
  const msg = (
    await request("/messages", a.token, "POST", {
      roomId: id,
      content: "Remember me",
    })
  ).body.data;
  const reminder = (
    await request("/experience/reminders", b.token, "POST", {
      messageId: msg.id,
      dueAt: new Date(Date.now() + 60000).toISOString(),
    })
  ).body.data;
  assert.ok(reminder.id);
  await query(
    "UPDATE message_reminders SET due_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [reminder.id],
  );
  const worker = require("../src/services/experienceWorker.service");
  await Promise.all([worker.run(), worker.run()]);
  assert.equal(
    (
      await query(
        "SELECT COUNT(*)::int AS n FROM notifications WHERE recipient_id=$1 AND type='reminder' AND reference_id=$2",
        [b.userId, msg.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await request("/experience/reminders", a.token)).body.data.length,
    0,
  );
});
test("ux: disappearing messages obey admin policy and expire before cleanup runs", async () => {
  const a = await account(),
    b = await account(),
    id = await room(a, b);
  assert.equal(
    (
      await request(`/experience/rooms/${id}/retention`, b.token, "PATCH", {
        seconds: 86400,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/experience/rooms/${id}/retention`, a.token, "PATCH", {
        seconds: 86400,
      })
    ).status,
    200,
  );
  const clientId = randomUUID();
  const msg = (
    await request("/messages", a.token, "POST", {
      roomId: id,
      content: "Temporary body",
      clientId,
    })
  ).body.data;
  assert.ok(msg.expires_at);
  const attachmentId = randomUUID(),
    objectKey = `expiry/${randomUUID()}`;
  await query(
    "INSERT INTO attachments(id,message_id,filename,file_url,file_type,size_bytes,public_id,resource_type) VALUES($1,$2,'expiry.txt',$3,'text/plain',4,$4,'r2')",
    [attachmentId, msg.id, `r2://fixture/${objectKey}`, objectKey],
  );
  await query(
    "UPDATE messages SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [msg.id],
  );
  const visible = await request(`/messages/room/${id}`, b.token);
  assert.equal(visible.status, 200);
  assert.equal(visible.body.data.messages.some(message => message.id === msg.id), false,
    "expired content is hidden while unrelated retention notices may remain");
  assert.equal(
    (await request(`/messages/room/${id}?ids=${msg.id}`, b.token)).body.data
      .missingIds[0],
    msg.id,
  );
  assert.equal(
    (
      await request(`/messages/${msg.id}`, a.token, "PATCH", {
        content: "Reappearing body",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/messages/${msg.id}/reactions`, b.token, "PUT", {
        emoji: "🚀",
      })
    ).status,
    404,
  );
  assert.equal(
    (await request(`/attachments/${attachmentId}`, b.token)).status,
    404,
  );
  assert.equal(
    (
      await request(`/messages/${msg.id}/pin`, a.token, "PUT", {
        scope: "user",
      })
    ).status,
    404,
  );
  const retry = await request("/messages", a.token, "POST", {
    roomId: id,
    clientId,
    content: "Temporary body",
  });
  assert.equal(retry.status, 201);
  assert.equal(retry.body.data.id, msg.id);
  assert.equal(retry.body.data.content, null);
  const pollResponse = await request("/polls", a.token, "POST", {
    roomId: id,
    question: "Temporary poll",
    options: ["A", "B"],
  });
  assert.equal(pollResponse.status, 201);
  const pollMessage = pollResponse.body.data;
  await query(
    "UPDATE messages SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [pollMessage.id],
  );
  assert.equal(
    (
      await request(`/polls/${pollMessage.poll.id}/vote`, b.token, "PUT", {
        optionIds: [],
      })
    ).status,
    404,
  );
  assert.equal(
    (await request(`/polls/${pollMessage.poll.id}/close`, a.token, "POST"))
      .status,
    404,
  );
  await require("../src/services/experienceWorker.service").run();
  assert.equal(
    (await query("SELECT 1 FROM polls WHERE message_id=$1", [pollMessage.id]))
      .rowCount,
    0,
  );

  assert.equal(
    (
      await query("SELECT 1 FROM storage_deletion_jobs WHERE object_key=$1", [
        objectKey,
      ])
    ).rowCount,
    1,
  );
  const row = (
    await query(
      "SELECT content,deleted_at FROM messages WHERE id=$1",
      [msg.id],
    )
  ).rows[0];
  assert.equal(row.content, null);
  assert.ok(row.deleted_at);
});
test("ux: duration, mention levels, DND and admin broadcast mentions are enforced", async () => {
  const a = await account(),
    b = await account(),
    id = await room(a, b);
  const prefs = await request(
    `/experience/rooms/${id}/notifications`,
    b.token,
    "PATCH",
    { level: "mentions", mute: "hour" },
  );
  assert.equal(prefs.status, 200);
  assert.ok(prefs.body.data.mute_until);
  const kept = await request(
    `/experience/rooms/${id}/notifications`,
    b.token,
    "PATCH",
    { level: "all", mute: "keep" },
  );
  assert.equal(kept.body.data.mute_until, prefs.body.data.mute_until);
  const policy = require("../src/services/notificationPolicy.service");
  assert.equal(
    policy.allowsInterruption(
      { notification_level: "mentions" },
      "new_message",
    ),
    false,
  );
  assert.equal(
    policy.allowsInterruption({ notification_level: "mentions" }, "mention"),
    true,
  );
  assert.equal(
    policy.allowsInterruption(
      { dnd_until: new Date(Date.now() + 60000).toISOString() },
      "mention",
    ),
    false,
  );
  const focus = await request(
    "/experience/personal-settings",
    b.token,
    "PATCH",
    { status: "Focused", dnd: "hour" },
  );
  assert.equal(focus.status, 200);
  assert.equal(focus.body.data.custom_status, "Focused");
  const keptFocus = await request(
    "/experience/personal-settings",
    b.token,
    "PATCH",
    { status: "Still focused", dnd: "keep" },
  );
  assert.equal(keptFocus.body.data.dnd_until, focus.body.data.dnd_until);
  assert.equal(
    (
      await request("/messages", b.token, "POST", {
        roomId: id,
        content: "@channel attention",
        broadcastMention: "channel",
      })
    ).status,
    403,
  );
  const mention = await request("/messages", a.token, "POST", {
    roomId: id,
    content: "@channel attention",
    broadcastMention: "channel",
  });
  assert.equal(mention.status, 201);
  assert.equal(
    (
      await query(
        "SELECT 1 FROM message_mentions WHERE message_id=$1 AND user_id=$2",
        [mention.body.data.id, b.userId],
      )
    ).rowCount,
    1,
  );
});

test('message budget is shared across two API instances and active sessions', async () => {
  const sender = await account();
  const peerSession = await session(sender.userId);
  const receiver = await account();
  const id = await room(sender, receiver);
  const a = await open(sender.token, 0);
  const b = await open(peerSession.token, 1);
  for (let index = 0; index < 30; index++) {
    const result = await ack(index % 2 ? a : b, 'send-message', {
      roomId: id, content: `Shared limit ${index}`, clientId: randomUUID(),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const result = await ack(b, 'send-message', { roomId: id, content: 'Over shared budget', clientId: randomUUID() });
  assert.equal(result.status, 429);
  const count = await query('SELECT COUNT(*)::int AS count FROM messages WHERE room_id=$1', [id]);
  assert.equal(count.rows[0].count, 30);
});

test('indicator budget is shared by sockets reusing one session across servers', async () => {
  const sender = await account();
  const receiver = await account();
  const id = await room(sender, receiver);
  const a = await open(sender.token, 0);
  const b = await open(sender.token, 1);
  for (const socket of [a, b]) {
    await ack(socket, 'join-room', { roomId: id });
    await ack(socket, 'heartbeat', { foreground: true, roomId: id, revision: 1 });
  }
  for (let index = 0; index < 24; index++) {
    const result = await ack(index % 2 ? a : b, 'typing', { roomId: id });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal((await ack(b, 'typing', { roomId: id })).status, 429);
});

test("project creation requires valid initial rooms and enforces role-based visibility", async () => {
  const owner = await account();
  const adminMember = await account();
  const ordinaryMember = await account();
  const team = await createTeam(owner, "Project policy team");
  const otherTeam = await createTeam(owner, "Other project team");
  await acceptTeamInvite(owner, team.id, adminMember);
  await acceptTeamInvite(owner, team.id, ordinaryMember);
  assert.equal((await request(`/teams/${team.id}/members/${adminMember.userId}`, owner.token, "PATCH", { role: "admin" })).status, 200);
  const restrictedRoom = await request(`/teams/${team.id}/rooms`, owner.token, "POST", { name: "Leadership", type: "group" });
  assert.equal(restrictedRoom.status, 201);

  assert.equal((await request(`/teams/${team.id}/projects`, owner.token, "POST", {
    name: "Duplicate selection",
    roomIds: [restrictedRoom.body.data.id, restrictedRoom.body.data.id],
  })).status, 400);
  assert.equal((await request(`/teams/${team.id}/projects`, owner.token, "POST", {
    name: "Cross team selection",
    roomIds: [restrictedRoom.body.data.id, otherTeam.general_room_id],
  })).status, 403);
  assert.equal((await request(`/teams/${team.id}/projects`, ordinaryMember.token, "POST", {
    name: "Member project",
    roomIds: [team.general_room_id],
  })).status, 403);

  const created = await request(`/teams/${team.id}/projects`, owner.token, "POST", {
    name: "Private roadmap",
    description: "Visible by policy",
    roomIds: [restrictedRoom.body.data.id],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const projectId = created.body.data.id;
  assert.equal((await request(`/work/projects/${projectId}/rooms`, owner.token, "POST", {
    roomId: restrictedRoom.body.data.id,
  })).status, 409);
  assert.equal((await request(`/work/projects/${projectId}/rooms`, owner.token, "POST", {
    roomId: otherTeam.general_room_id,
  })).status, 409);
  assert.equal((await request(`/work/projects/${projectId}`, owner.token)).status, 200);
  assert.equal((await request(`/work/projects/${projectId}`, adminMember.token)).status, 200);
  assert.equal((await request(`/work/projects/${projectId}`, ordinaryMember.token)).status, 404);
  const adminList = await request("/work/projects", adminMember.token);
  const memberList = await request("/work/projects", ordinaryMember.token);
  assert.ok(adminList.body.data.projects.some((project) => project.id === projectId && project.can_manage));
  assert.ok(!memberList.body.data.projects.some((project) => project.id === projectId));
  assert.equal((await request(`/work/projects/${projectId}/task-search?q=secret`, ordinaryMember.token)).status, 404);
  assert.equal((await request(`/work/projects/${projectId}`, adminMember.token, "PATCH", {
    name: "Admin managed roadmap",
    description: "Updated by another administrator",
    status: "completed",
  })).status, 200);
  assert.equal((await request(`/teams/${team.id}/members/${adminMember.userId}`, owner.token, "DELETE")).status, 200);
  assert.equal((await request(`/work/projects/${projectId}`, adminMember.token)).status, 404);
  assert.ok(!(await request("/work/projects", adminMember.token)).body.data.projects.some((project) => project.id === projectId));
});

test("project milestones and dependencies cleanly detach with a removed room", async () => {
  const owner = await account();
  const team = await createTeam(owner, "Project cleanup team");
  const extraRoom = await request(`/teams/${team.id}/rooms`, owner.token, "POST", { name: "Execution", type: "group" });
  const project = await request(`/teams/${team.id}/projects`, owner.token, "POST", {
    name: "Delivery plan",
    roomIds: [team.general_room_id, extraRoom.body.data.id],
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const projectId = project.body.data.id;
  const milestone = await request(`/work/projects/${projectId}/milestones`, owner.token, "POST", {
    title: "Beta gate",
    dueDate: "2026-12-15",
  });
  assert.equal(milestone.status, 201);
  const keptTask = await request("/tasks", owner.token, "POST", {
    roomId: team.general_room_id,
    clientId: randomUUID(),
    title: "Kept task",
  });
  const detachedTask = await request("/tasks", owner.token, "POST", {
    roomId: extraRoom.body.data.id,
    clientId: randomUUID(),
    title: "Detached task",
  });
  assert.equal(keptTask.status, 201);
  assert.equal(detachedTask.status, 201);
  for (const taskId of [keptTask.body.data.id, detachedTask.body.data.id])
    assert.equal((await request(`/work/tasks/${taskId}/milestone`, owner.token, "PATCH", { milestoneId: milestone.body.data.id })).status, 200);
  assert.equal((await request(`/work/tasks/${detachedTask.body.data.id}/dependencies`, owner.token, "POST", {
    dependsOnId: keptTask.body.data.id,
  })).status, 201);
  assert.equal((await request(`/work/tasks/${keptTask.body.data.id}/dependencies`, owner.token, "POST", {
    dependsOnId: detachedTask.body.data.id,
  })).status, 409);
  assert.equal((await request(`/work/projects/${projectId}/milestones/${milestone.body.data.id}`, owner.token, "PATCH", {
    title: "Beta gate",
    dueDate: "2026-12-15",
    completed: true,
  })).status, 200);
  assert.equal((await request(`/work/projects/${projectId}/rooms/${extraRoom.body.data.id}`, owner.token, "DELETE")).status, 200);

  const detached = (await query("SELECT project_id,milestone_id FROM tasks WHERE id=$1", [detachedTask.body.data.id])).rows[0];
  const kept = (await query("SELECT project_id,milestone_id FROM tasks WHERE id=$1", [keptTask.body.data.id])).rows[0];
  assert.equal(detached.project_id, null);
  assert.equal(detached.milestone_id, null);
  assert.equal(kept.project_id, projectId);
  assert.equal(kept.milestone_id, milestone.body.data.id);
  assert.equal((await query("SELECT count(*)::int AS count FROM task_dependencies WHERE task_id=$1 OR depends_on_id=$1", [detachedTask.body.data.id])).rows[0].count, 0);
  assert.equal((await query("SELECT count(*)::int AS count FROM project_rooms WHERE project_id=$1", [projectId])).rows[0].count, 1);
});

test("room brief updates use optimistic concurrency and preserve revisions", async () => {
  const owner = await account();
  const team = await createTeam(owner, "Brief concurrency team");
  const initial = await request(`/work/rooms/${team.general_room_id}/brief`, owner.token, "PUT", {
    body: "Initial project brief",
    version: null,
  });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.data.version, 1);
  const updates = await Promise.all([
    request(`/work/rooms/${team.general_room_id}/brief`, owner.token, "PUT", { body: "Editor A", version: 1 }),
    request(`/work/rooms/${team.general_room_id}/brief`, owner.token, "PUT", { body: "Editor B", version: 1 }),
  ]);
  assert.deepEqual(updates.map((response) => response.status).sort(), [200, 409]);
  const current = await request(`/work/rooms/${team.general_room_id}/brief`, owner.token);
  assert.equal(current.body.data.brief.version, 2);
  assert.equal(current.body.data.revisions.length, 2);
  assert.ok(["Editor A", "Editor B"].includes(current.body.data.brief.body));
});

test("project automation claims each event once across competing workers", async () => {
  const owner = await account();
  const team = await createTeam(owner, "Automation team");
  const project = await request(`/teams/${team.id}/projects`, owner.token, "POST", {
    name: "Automated follow-up",
    roomIds: [team.general_room_id],
  });
  const rule = await request(`/work/projects/${project.body.data.id}/automations`, owner.token, "POST", {
    triggerKind: "decision_recorded",
    titlePrefix: "Follow up:",
  });
  assert.equal(rule.status, 201, JSON.stringify(rule.body));
  const decision = await request("/decisions", owner.token, "POST", {
    roomId: team.general_room_id,
    clientId: randomUUID(),
    title: "Ship the beta",
    body: "Proceed with the controlled cohort.",
    tags: ["beta"],
  });
  assert.equal(decision.status, 201);
  const automation = require("../src/services/projectAutomation.service");
  await Promise.all([automation.run(servers[0].io), automation.run(servers[1].io)]);
  const eventKey = `decision:${decision.body.data.id}`;
  assert.equal((await query("SELECT count(*)::int AS count FROM project_automation_runs WHERE rule_id=$1 AND event_key=$2", [rule.body.data.id, eventKey])).rows[0].count, 1);
  const generated = await query("SELECT id,project_id,decision_id FROM tasks WHERE decision_id=$1 AND project_id=$2", [decision.body.data.id, project.body.data.id]);
  assert.equal(generated.rowCount, 1);
  await automation.run(servers[0].io);
  assert.equal((await query("SELECT count(*)::int AS count FROM tasks WHERE decision_id=$1 AND project_id=$2", [decision.body.data.id, project.body.data.id])).rows[0].count, 1);
});

test("project automation rolls back a failed event claim so the next scan can retry", async () => {
  const owner = await account();
  const team = await createTeam(owner, "Automation retry team");
  const project = await request(`/teams/${team.id}/projects`, owner.token, "POST", {
    name: "Retryable automation",
    roomIds: [team.general_room_id],
  });
  const rule = await request(`/work/projects/${project.body.data.id}/automations`, owner.token, "POST", {
    triggerKind: "decision_recorded",
    titlePrefix: "Retry:",
  });
  const decision = await request("/decisions", owner.token, "POST", {
    roomId: team.general_room_id,
    clientId: randomUUID(),
    title: "Retry this event",
    body: "A temporary worker failure must not lose this action.",
    tags: [],
  });
  assert.equal(decision.status, 201, JSON.stringify(decision.body));
  const automation = require("../src/services/projectAutomation.service");
  const { Client } = require("pg");
  const originalQuery = Client.prototype.query;
  let failTaskInsert = true;
  Client.prototype.query = function (...args) {
    const [sql] = args;
    if (failTaskInsert && typeof sql === "string" &&
        sql.includes("INSERT INTO tasks(room_id,title,initial_title,created_by,decision_id,project_id)")) {
      failTaskInsert = false;
      const error = new Error("simulated transient task write failure");
      error.code = "XX000";
      return Promise.reject(error);
    }
    return originalQuery.apply(this, args);
  };
  try {
    await automation.run(servers[0].io);
    const eventKey = `decision:${decision.body.data.id}`;
    assert.equal((await query("SELECT count(*)::int AS count FROM project_automation_runs WHERE rule_id=$1 AND event_key=$2",
      [rule.body.data.id, eventKey])).rows[0].count, 0);
    assert.equal((await query("SELECT count(*)::int AS count FROM tasks WHERE decision_id=$1", [decision.body.data.id])).rows[0].count, 0);
    await automation.run(servers[0].io);
    assert.equal((await query("SELECT count(*)::int AS count FROM project_automation_runs WHERE rule_id=$1 AND event_key=$2",
      [rule.body.data.id, eventKey])).rows[0].count, 1);
    assert.equal((await query("SELECT count(*)::int AS count FROM tasks WHERE decision_id=$1", [decision.body.data.id])).rows[0].count, 1);
  } finally {
    Client.prototype.query = originalQuery;
  }
});

test("work inbox and search immediately follow content and membership changes", async () => {
  const owner = await account();
  const member = await account();
  const team = await createTeam(owner, "Work discovery team");
  await acceptTeamInvite(owner, team.id, member);
  const message = await request("/messages", owner.token, "POST", {
    roomId: team.general_room_id,
    clientId: randomUUID(),
    content: "LifecycleNeedle launch context",
  });
  const task = await request("/tasks", owner.token, "POST", {
    roomId: team.general_room_id,
    clientId: randomUUID(),
    title: "LifecycleNeedle follow-up",
    assigneeId: member.userId,
  });
  assert.equal(message.status, 201);
  assert.equal(task.status, 201);
  const beforeSearch = await request("/work/search?q=LifecycleNeedle", member.token);
  const beforeInbox = await request("/work/inbox", member.token);
  assert.equal(beforeSearch.status, 200, JSON.stringify(beforeSearch.body));
  assert.equal(beforeInbox.status, 200, JSON.stringify(beforeInbox.body));
  assert.ok(beforeSearch.body.data.items.some((item) => item.id === message.body.data.id));
  assert.ok(beforeSearch.body.data.items.some((item) => item.id === task.body.data.id));
  assert.ok(beforeInbox.body.data.items.some((item) => item.event_key === `assignment:${task.body.data.id}`));

  assert.equal((await request(`/messages/${message.body.data.id}`, owner.token, "DELETE")).status, 200);
  assert.equal((await request(`/tasks/${task.body.data.id}/status`, member.token, "PATCH", { status: "done" })).status, 200);
  const afterContentSearch = await request("/work/search?q=LifecycleNeedle", member.token);
  const afterContentInbox = await request("/work/inbox", member.token);
  assert.equal(afterContentSearch.status, 200, JSON.stringify(afterContentSearch.body));
  assert.equal(afterContentInbox.status, 200, JSON.stringify(afterContentInbox.body));
  assert.ok(!afterContentSearch.body.data.items.some((item) => item.id === message.body.data.id));
  assert.ok(afterContentSearch.body.data.items.some((item) => item.id === task.body.data.id));
  assert.ok(!afterContentInbox.body.data.items.some((item) => item.id === task.body.data.id));

  assert.equal((await request(`/teams/${team.id}/members/${member.userId}`, owner.token, "DELETE")).status, 200);
  const afterRemovalSearch = await request("/work/search?q=LifecycleNeedle", member.token);
  const afterRemovalInbox = await request("/work/inbox", member.token);
  assert.equal(afterRemovalSearch.status, 200, JSON.stringify(afterRemovalSearch.body));
  assert.equal(afterRemovalInbox.status, 200, JSON.stringify(afterRemovalInbox.body));
  assert.ok(!afterRemovalSearch.body.data.items.some((item) => item.room_id === team.general_room_id));
  assert.ok(!afterRemovalInbox.body.data.items.some((item) => item.room_id === team.general_room_id));
});

test("project lists and work inbox paginate beyond their former fixed result limits", async () => {
  const owner = await account();
  const team = await createTeam(owner, "Paged work team");
  const project = await request(`/teams/${team.id}/projects`, owner.token, "POST", {
    name: "Paged work project",
    roomIds: [team.general_room_id],
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  await query(
    `INSERT INTO tasks(room_id,title,initial_title,created_by,project_id,assignee_id,created_at,updated_at)
     SELECT $1,'Paged task '||g,'Paged task '||g,$2,$3,$2,NOW()+g*INTERVAL '1 second',NOW()
     FROM generate_series(1,55) g`,
    [team.general_room_id, owner.userId, project.body.data.id],
  );
  await query(
    `INSERT INTO decisions(room_id,title,body,tags,created_by,created_at,updated_at)
     SELECT $1,'Paged decision '||g,'Page coverage',ARRAY[]::text[],$2,NOW()+g*INTERVAL '1 second',NOW()+g*INTERVAL '1 second'
     FROM generate_series(1,55) g`,
    [team.general_room_id, owner.userId],
  );
  const first = await request(`/work/projects/${project.body.data.id}?taskPage=1&decisionPage=1`, owner.token);
  const second = await request(`/work/projects/${project.body.data.id}?taskPage=2&decisionPage=2`, owner.token);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.tasks.length, 50);
  assert.equal(first.body.data.decisions.length, 50);
  assert.equal(first.body.data.pagination.tasks.hasMore, true);
  assert.equal(first.body.data.pagination.decisions.hasMore, true);
  assert.equal(second.body.data.tasks.length, 5);
  assert.equal(second.body.data.decisions.length, 5);
  assert.equal(second.body.data.pagination.tasks.hasMore, false);
  assert.equal(second.body.data.pagination.decisions.hasMore, false);
  assert.equal(first.body.data.report.total, 55);
  const taskPicker = await request(`/work/projects/${project.body.data.id}/task-search?q=Paged%20task%2055`, owner.token);
  assert.ok(taskPicker.body.data.tasks.some((task) => task.title === "Paged task 55"));

  const inboxFirst = await request("/work/inbox?page=1", owner.token);
  const inboxSecond = await request("/work/inbox?page=2", owner.token);
  assert.equal(inboxFirst.body.data.items.length, 50);
  assert.equal(inboxFirst.body.data.hasMore, true);
  assert.equal(inboxSecond.body.data.items.length, 5);
  assert.equal(inboxSecond.body.data.hasMore, false);
});

test("history clearing and leaving a room immediately filter work search, inbox, and brief sources", async () => {
  const owner = await account();
  const member = await account();
  const team = await createTeam(owner, "Work visibility team");
  await acceptTeamInvite(owner, team.id, member);
  const message = await request("/messages", owner.token, "POST", {
    roomId: team.general_room_id,
    clientId: randomUUID(),
    content: "PrivateHistoryMarker retained only for the author",
  });
  assert.equal(message.status, 201, JSON.stringify(message.body));
  const task = await request("/tasks", owner.token, "POST", {
    roomId: team.general_room_id,
    clientId: randomUUID(),
    title: "Room leave assignment marker",
    assigneeId: member.userId,
  });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  const brief = await request(`/work/rooms/${team.general_room_id}/brief`, owner.token, "PUT", {
    body: "Context linked to a message",
    sourceMessageId: message.body.data.id,
    version: null,
  });
  assert.equal(brief.status, 200, JSON.stringify(brief.body));
  const beforeClearBrief = await request(`/work/rooms/${team.general_room_id}/brief`, member.token);
  assert.equal(beforeClearBrief.status, 200, JSON.stringify(beforeClearBrief.body));
  assert.equal(beforeClearBrief.body.data.brief.source_message_id, message.body.data.id);

  assert.equal((await request(`/rooms/${team.general_room_id}/clear`, member.token, "POST")).status, 200);
  const afterClearSearch = await request("/work/search?q=PrivateHistoryMarker", member.token);
  const afterClearBrief = await request(`/work/rooms/${team.general_room_id}/brief`, member.token);
  const afterClearInbox = await request("/work/inbox", member.token);
  assert.equal(afterClearSearch.status, 200, JSON.stringify(afterClearSearch.body));
  assert.equal(afterClearBrief.status, 200, JSON.stringify(afterClearBrief.body));
  assert.equal(afterClearInbox.status, 200, JSON.stringify(afterClearInbox.body));
  assert.ok(!afterClearSearch.body.data.items.some((item) => item.id === message.body.data.id));
  assert.equal(afterClearBrief.body.data.brief.source_message_id, null);
  assert.ok(afterClearInbox.body.data.items.some((item) => item.event_key === `assignment:${task.body.data.id}`));

  assert.equal((await request(`/rooms/${team.general_room_id}/members/${member.userId}`, member.token, "DELETE")).status, 200);
  const afterLeaveSearch = await request("/work/search?q=Room%20leave", member.token);
  const afterLeaveInbox = await request("/work/inbox", member.token);
  assert.equal(afterLeaveSearch.status, 200, JSON.stringify(afterLeaveSearch.body));
  assert.equal(afterLeaveInbox.status, 200, JSON.stringify(afterLeaveInbox.body));
  assert.ok(!afterLeaveSearch.body.data.items.some((item) => item.room_id === team.general_room_id));
  assert.ok(!afterLeaveInbox.body.data.items.some((item) => item.room_id === team.general_room_id));
});
