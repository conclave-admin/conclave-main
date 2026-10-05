const test = require('node:test');
const assert = require('node:assert/strict');
const presence = require('../src/services/presence.service');
const db = require('../src/config/db');
const registerSocketHandlers = require('../src/sockets');

test('an immediate room join waits for presence initialization without being lost', async (t) => {
  let finishInitialization;
  t.mock.method(presence, 'socketConnected', () => new Promise((resolve) => { finishInitialization = () => resolve(1); }));
  for (const method of ['userConnected', 'userJoinedRoom']) t.mock.method(presence, method, async () => {});
  for (const method of ['getRoomOnlineUsers', 'getTypingUsers']) t.mock.method(presence, method, async () => []);
  t.mock.method(presence, 'startHeartbeatSweep', () => {});
  let queries = 0;
  t.mock.method(db.pool, 'query', async () => { queries++; return { rows: [{}] }; });
  let connect;
  const io = { use() {}, on(event, handler) { connect = handler; }, to() { return { emit() {} }; } };
  registerSocketHandlers(io);
  const handlers = new Map();
  let joined;
  connect({
    id: 'socket-id', user: { id: 'user-id' }, connected: true,
    broadcast: { emit() {} }, emit() {},
    on: (event, handler) => handlers.set(event, handler),
    join: (roomId) => { joined = roomId; },
  });
  assert.ok(handlers.has('join-room'));
  const pending = handlers.get('join-room')({ roomId: 'room-id' });
  await Promise.resolve();
  assert.equal(queries, 0);
  finishInitialization();
  await pending;
  assert.equal(joined, 'room-id');
  assert.equal(queries, 1);
});
