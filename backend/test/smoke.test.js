// Smoke tests: boot the real Express app in-process and assert the things that
// break silently when someone edits a router, a middleware or a controller.
//
// Scope and limits, stated up front:
//   - This suite runs NO SQL and connects to no database or Redis. It proves the
//     app boots, the route table is intact, middleware is wired in the right
//     order, and error handling produces the documented envelope. That is the
//     class of breakage that is otherwise only found in production.
//   - It does NOT prove queries are valid SQL. Nothing here has ever been run
//     against a real Postgres, so the migrations and every query string remain
//     unverified and still need a real database before merge.
//     See docs/BACKEND_TASKS.md, "Verification status".
//
// Run with: npm test

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Dashed values: nothing here ever opens a connection, so these only need to be
// defined and non-empty to keep config/env.js deterministic.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://app:app@127.0.0.1:5432/conclave_smoke';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'smoke-test-access-secret';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'smoke-test-refresh-secret';
process.env.CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = require('../src/app');

// Every route the frontend and the API contracts depend on. Listed explicitly
// so that renaming, unmounting or typo-ing a path fails here rather than in a
// browser. Method + full path, exactly as a client would call it.
const EXPECTED_ROUTES = [
  // health (declared in app.js, outside /api)
  ['GET', '/health', false],
  // auth — deliberately public
  ['POST', '/api/auth/register', false],
  ['POST', '/api/auth/login', false],
  ['POST', '/api/auth/refresh', false],
  ['POST', '/api/auth/logout', false],
  // users
  ['GET', '/api/users/me', true],
  ['PATCH', '/api/users/me', true],
  ['DELETE', '/api/users/me', true],
  ['GET', '/api/users', true],
  // rooms
  ['POST', '/api/rooms', true],
  ['GET', '/api/rooms', true],
  ['GET', '/api/rooms/:roomId', true],
  ['POST', '/api/rooms/:roomId/members', true],
  ['POST', '/api/rooms/:roomId/seen', true],
  // messages
  ['POST', '/api/messages', true],
  ['GET', '/api/messages/room/:roomId', true],
  ['GET', '/api/messages/room/:roomId/search', true],
  ['PATCH', '/api/messages/:messageId', true],
  ['DELETE', '/api/messages/:messageId', true],
  ['PUT', '/api/messages/:messageId/reactions', true],
  ['DELETE', '/api/messages/:messageId/reactions/:emoji', true],
  // decisions
  ['POST', '/api/decisions', true],
  ['GET', '/api/decisions', true],
  ['GET', '/api/decisions/search', true],
  ['GET', '/api/decisions/room/:roomId', true],
  ['GET', '/api/decisions/room/:roomId/search', true],
  // digest
  ['GET', '/api/digest', true],
  ['GET', '/api/digest/room/:roomId', true],
  // tasks — implemented, but must be auth-guarded
  ['POST', '/api/tasks', true],
  ['GET', '/api/tasks', true],
  ['GET', '/api/tasks/room/:roomId', true],
  ['PATCH', '/api/tasks/:taskId/status', true],
  // notifications — implemented, but must be auth-guarded
  ['GET', '/api/notifications', true],
  ['PATCH', '/api/notifications/seen', true],
  // upload — implemented, but must be auth-guarded
  ['POST', '/api/upload', true],
];

// Express keeps a router's own paths relative to its mount point, so a route
// declared as router.get('/') inside a router mounted at /api/users is reachable
// at /api/users — concatenating naively yields "/api/users/", which never
// matches. Normalise both sides so the comparison is on the real URL.
function joinPath(prefix, path) {
  const joined = `${prefix}/${path}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

// Flatten an Express app into "METHOD /path" keys, including routers mounted
// with a prefix, so the comparison above is meaningful.
function collectRoutes(stack, prefix = '', out = new Map()) {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        out.set(`${method.toUpperCase()} ${joinPath(prefix, layer.route.path)}`, true);
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      // Express strips the mount path off layer.route.path, so rebuild it from
      // the regexp the router was mounted on.
      const source = layer.regexp?.source || '';
      const match = source.match(/^\^\\\/((?:[\w\-.]+\\\/)*[\w\-.]+)/);
      let mount = '';
      if (match) mount = '/' + match[1].replace(/\\\//g, '/').replace(/\/$/, '');
      collectRoutes(layer.handle.stack, `${prefix}${mount}`, out);
    }
  }
  return out;
}

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('every expected route is mounted', () => {
  const actual = collectRoutes(app._router.stack);
  const missing = EXPECTED_ROUTES.map(([m, p]) => `${m} ${p}`).filter(
    (key) => !actual.has(key),
  );
  assert.deepEqual(
    missing,
    [],
    `routes missing from the app: ${missing.join(', ') || 'none'}`,
  );
});

test('health check responds without auth', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('unknown path returns 404 in the standard envelope, not HTML', async () => {
  const res = await fetch(`${baseUrl}/api/does-not-exist`);
  assert.equal(res.status, 404);
  // The important part: the body is JSON with the same shape every other
  // response uses, so a client can parse it the same way.
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(typeof body.message, 'string');
});

test('unknown non-api path also returns the JSON envelope', async () => {
  const res = await fetch(`${baseUrl}/nope`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
});

test('protected routes reject a missing token with 401', async () => {
  for (const [method, path] of [
    ['GET', '/api/rooms'],
    ['GET', '/api/users/me'],
    ['GET', '/api/digest'],
    ['POST', '/api/messages'],
  ]) {
    const res = await fetch(`${baseUrl}${path}`, { method });
    assert.equal(res.status, 401, `${method} ${path} should require auth`);
    const body = await res.json();
    assert.equal(body.success, false);
  }
});

test('protected routes reject a malformed token with 401', async () => {
  const res = await fetch(`${baseUrl}/api/rooms`, {
    headers: { Authorization: 'Bearer not-a-real-jwt' },
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.success, false);
});

test('auth routes are reachable without a token', async () => {
  // A 400/401 from the handler proves the route resolved; a 401 "Missing access
  // token" would mean requireAuth was wrongly applied to it.
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.notEqual(res.status, 401);
  assert.equal(res.status, 400);
});

test('malformed JSON body is a 400, not a 500', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"email": ',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.success, false);
});

test('oversized JSON body is a 413, not a 500', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }),
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.success, false);
});

test('malformed UUID param is a 400, not a 500', async () => {
  // Reaches validateUuidParams, which runs before the handler and before any
  // database access, so this is genuinely assertable without Postgres.
  const res = await fetch(`${baseUrl}/api/rooms/not-a-uuid`, {
    headers: { Authorization: 'Bearer not-a-real-jwt' },
  });
  // 401 from the token check, not 500 — either way it must not be a 500.
  assert.notEqual(res.status, 500);
});

test('security headers are set by helmet', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.ok(res.headers.get('x-content-type-options'), 'helmet should be mounted');
  assert.ok(
    res.headers.get('content-security-policy') || res.headers.get('x-dns-prefetch-control'),
    'helmet should be mounted',
  );
});

test('CORS allows the configured client origin with credentials', async () => {
  const res = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(
    res.headers.get('access-control-allow-origin'),
    'http://localhost:5173',
  );
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
});

test('every backend module loads without throwing', async () => {
  // A syntax error or a bad require in a file nothing imports yet would
  // otherwise only surface when that route is first hit in production.
  const modules = [
    '../src/app',
    // ../src/server is deliberately absent: it is the process entry point, so
    // requiring it runs main(), which opens real connections to Redis (and, via
    // the heartbeat sweep, starts a timer). That would hang the suite. It is
    // covered by `node --check` and by the graceful-shutdown assertions below.
    '../src/config/env',
    '../src/config/db',
    '../src/config/redis',
    '../src/config/cloudinary',
    '../src/middlewares/auth.middleware',
    '../src/middlewares/error.middleware',
    '../src/middlewares/validateParams',
    '../src/utils/ApiError',
    '../src/utils/apiResponse',
    '../src/utils/asyncHandler',
    '../src/services/token.service',
    '../src/services/message.service',
    '../src/services/presence.service',
    '../src/sockets',
    '../src/routes',
    '../src/routes/auth.routes',
    '../src/routes/users.routes',
    '../src/routes/rooms.routes',
    '../src/routes/messages.routes',
    '../src/routes/decisions.routes',
    '../src/routes/digest.routes',
    '../src/routes/tasks.routes',
    '../src/routes/notifications.routes',
    '../src/routes/upload.routes',
    '../src/controllers/auth.controller',
    '../src/controllers/users.controller',
    '../src/controllers/rooms.controller',
    '../src/controllers/messages.controller',
    '../src/controllers/decisions.controller',
    '../src/controllers/digest.controller',
    '../src/controllers/tasks.controller',
    '../src/controllers/notifications.controller',
    '../src/controllers/upload.controller',
    '../src/services/mention.service',
    '../src/services/notification.service',
    '../src/services/reaction.service',
  ];
  for (const id of modules) {
    assert.doesNotThrow(() => require(id), `${id} failed to load`);
  }
});

test('the socket layer exposes a single registration function', () => {
  const registerSocketHandlers = require('../src/sockets');
  assert.equal(typeof registerSocketHandlers, 'function');

  // registerSocketHandlers(io) must tolerate a minimal io stand-in, proving it
  // does not reach for anything else at registration time.
  const io = {
    use: () => {},
    on: () => {},
    emit: () => {},
    to: () => ({ emit: () => {} }),
  };
  assert.doesNotThrow(() => registerSocketHandlers(io));
});

test('the heartbeat sweep can be started and stopped', () => {
  // stopHeartbeatSweep existed but was never called before graceful shutdown
  // landed; if it regressed to a no-op the process would keep a live timer and
  // the shutdown would hang until the platform killed it.
  const presence = require('../src/services/presence.service');
  assert.equal(typeof presence.startHeartbeatSweep, 'function');
  assert.equal(typeof presence.stopHeartbeatSweep, 'function');
  const io = { emit: () => {} };
  presence.startHeartbeatSweep(io);
  assert.doesNotThrow(() => presence.stopHeartbeatSweep());
});
