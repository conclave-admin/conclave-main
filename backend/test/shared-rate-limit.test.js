const test = require('node:test');
const assert = require('node:assert/strict');
const { redisClient } = require('../src/config/redis');
const rateLimit = require('../src/middlewares/rateLimit.middleware');
const socketHandler = require('../src/utils/socketHandler');

test('separate limiter instances share the same Redis budget and expiry', async (t) => {
  t.mock.getter(redisClient, 'isReady', () => true);
  const counts = new Map();
  const windows = [];
  t.mock.method(redisClient, 'eval', async (_script, { keys, arguments: args }) => {
    windows.push(args[0]);
    const next = (counts.get(keys[0]) || 0) + 1;
    counts.set(keys[0], next);
    return next;
  });
  const path = require.resolve('../src/middlewares/rateLimit.middleware');
  const previous = require.cache[path];
  delete require.cache[path];
  const peer = require(path);
  require.cache[path] = previous;
  for (let i = 0; i < 30; i++)
    await (i % 2 ? peer : rateLimit).requireShared('socket:user:messages', { windowMs: 60000, max: 30 }, 'Too many messages');
  await assert.rejects(peer.requireShared('socket:user:messages', { windowMs: 60000, max: 30 }, 'Too many messages'), { status: 429 });
  await rateLimit.requireShared('socket:other:messages', { windowMs: 60000, max: 30 }, 'Too many messages');
  assert.ok(windows.every(value => value === '60000'));
});

test('production store outages return retryable socket acknowledgements without executing work', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  t.mock.getter(redisClient, 'isReady', () => false);
  let executed = false;
  let acknowledgement;
  const socket = { connected: true, emit() {} };
  await socketHandler(socket, async () => {
    await rateLimit.requireShared('socket:user:messages', { windowMs: 60000, max: 30 }, 'Too many messages');
    executed = true;
  })({}, value => { acknowledgement = value; });
  assert.equal(executed, false);
  assert.equal(acknowledgement.status, 503);
  assert.equal(acknowledgement.ok, false);
});

test('Redis command failures fail closed and do not expose store details', async (t) => {
  t.mock.getter(redisClient, 'isReady', () => true);
  t.mock.method(redisClient, 'eval', async () => { throw new Error('private Redis details'); });
  await assert.rejects(rateLimit.requireShared('indicators:user', { windowMs: 10000, max: 48 }, 'Too many updates'), error => error.status === 503 && !error.message.includes('private'));
});

// Redis can be open while still reconnecting/authenticating. Never queue a
// production action behind an unavailable rate-limit store.
test('an open but unready production Redis connection fails immediately', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  t.mock.getter(redisClient, 'isOpen', () => true);
  t.mock.getter(redisClient, 'isReady', () => false);
  t.mock.method(redisClient, 'eval', () => assert.fail('must not queue an unavailable command'));
  await assert.rejects(rateLimit.requireShared('socket:reconnecting:messages', { windowMs: 60000, max: 30 }, 'Too many messages'), { status: 503 });
});
