const test = require('node:test');
const assert = require('node:assert/strict');
const socketHandler = require('../src/utils/socketHandler');
const ApiError = require('../src/utils/ApiError');

function fixture() {
  const events = [];
  return { events, socket: { connected: true, emit: (...args) => events.push(args) } };
}

test('missing and malformed payloads cannot escape the event handler', async () => {
  const { events, socket } = fixture();
  const handle = socketHandler(socket, () => assert.fail('invalid payload reached business logic'));
  for (const payload of [undefined, null, 'bad', 5, []]) await handle(payload);
  assert.equal(events.length, 5);
  assert.ok(events.every(([name]) => name === 'error:message'));
});

test('async failures are contained and internal details are withheld', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { events, socket } = fixture();
  await socketHandler(socket, async () => { throw new Error('private database error'); })({});
  assert.equal(events.length, 1);
  assert.doesNotMatch(events[0][1].message, /private database/);
});

test('expected validation messages are returned to the caller', async () => {
  const { events, socket } = fixture();
  await socketHandler(socket, async () => { throw new ApiError(403, 'Not a room member'); })({});
  assert.equal(events[0][1].message, 'Not a room member');
});

test('heartbeat and disconnect can omit an object payload', async () => {
  const { events, socket } = fixture();
  let calls = 0;
  const handle = socketHandler(socket, async () => { calls++; }, { payload: false });
  await handle();
  await handle('transport close');
  assert.equal(calls, 2);
  assert.deepEqual(events, []);
});
