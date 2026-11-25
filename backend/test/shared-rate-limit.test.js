const test = require('node:test');
const assert = require('node:assert/strict');
const { redisClient } = require('../src/config/redis');
const { pool } = require('../src/config/db');
const rateLimit = require('../src/middlewares/rateLimit.middleware');
const socketHandler = require('../src/utils/socketHandler');

// Model the ready event tracked separately from the client getter.
test.before(() => redisClient.emit('ready'));

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

test('production rate limits fall back to shared PostgreSQL counters when Redis is unavailable', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  t.mock.getter(redisClient, 'isReady', () => false);
  let count = 0;
  t.mock.method(pool, 'query', async (sql, params) => {
    assert.match(sql, /request_rate_limit_buckets/);
    assert.equal(params[1], 60000);
    count += 1;
    return { rows: [{ request_count: count }] };
  });
  let executed = false;
  let acknowledgement;
  const socket = { connected: true, emit() {} };
  await socketHandler(socket, async () => {
    await rateLimit.requireShared('socket:user:messages', { windowMs: 60000, max: 30 }, 'Too many messages');
    executed = true;
  })({}, value => { acknowledgement = value; });
  assert.equal(executed, true);
  assert.equal(acknowledgement, undefined);
  assert.equal(count, 1);
});

test('production rate limits fall back to PostgreSQL when a Redis command fails', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  t.mock.getter(redisClient, 'isReady', () => true);
  t.mock.method(redisClient, 'eval', async () => { throw new Error('private Redis details'); });
  t.mock.method(pool, 'query', async (sql) => {
    assert.match(sql, /request_rate_limit_buckets/);
    return { rows: [{ request_count: 1 }] };
  });
  assert.equal(await rateLimit.consumeShared('indicators:user', { windowMs: 10000, max: 48 }), true);
});

test('an open but unready production Redis connection uses the PostgreSQL fallback', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  t.mock.getter(redisClient, 'isOpen', () => true);
  t.mock.getter(redisClient, 'isReady', () => false);
  t.mock.method(redisClient, 'eval', () => assert.fail('must not queue an unavailable command'));
  t.mock.method(pool, 'query', async () => ({ rows: [{ request_count: 1 }] }));
  assert.equal(await rateLimit.consumeShared('socket:reconnecting:messages', { windowMs: 60000, max: 30 }), true);
});
