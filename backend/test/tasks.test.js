const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/config/db');
const tasks = require('../src/controllers/tasks.controller');
const ID = '10000000-0000-0000-0000-000000000001';

async function errorFrom(handler, overrides) {
  let error;
  await handler({ user: { id: ID }, params: {}, query: {}, body: {}, ...overrides },
    { status() { assert.fail('Invalid input must not succeed'); } }, (value) => { error = value; });
  assert.ok(error);
  return error;
}

test('task creation rejects malformed fields before accessing the database', async (t) => {
  t.mock.method(pool, 'connect', () => assert.fail('Validation must precede database access'));
  const valid = { roomId: ID, title: 'Review launch' };
  for (const patch of [
    { roomId: [] }, { title: '  ' }, { title: 42 }, { title: 'x'.repeat(201) },
    { assigneeId: '' }, { sourceMessageId: 'bad' }, { dueDate: '2026-02-30' },
    { dueDate: '2026-13-01' }, { dueDate: 'tomorrow' }, { dueDate: [] },
  ]) {
    const error = await errorFrom(tasks.createTask, { body: { ...valid, ...patch } });
    assert.equal(error.status, 400);
  }
});

test('task lists reject malformed filters and cursor dates', async (t) => {
  t.mock.method(pool, 'query', () => assert.fail('Validation must precede database access'));
  for (const query of [
    { status: 'unknown' }, { assigneeId: ['me'] }, { roomId: 'bad' },
    { before: [] }, { before: `2026-02-30T00:00:00.000000Z|${ID}` },
    { before: `2026-01-01T00:00:00.000000Z|bad` },
  ]) assert.equal((await errorFrom(tasks.listTasks, { query })).status, 400);
});

test('status updates reject invalid statuses and task IDs before database access', async (t) => {
  t.mock.method(pool, 'connect', () => assert.fail('Validation must precede database access'));
  for (const status of [undefined, null, 'closed', '', [], 1]) {
    const error = await errorFrom(tasks.updateTaskStatus, { params: { taskId: ID }, body: { status } });
    assert.equal(error.status, 400);
  }
  assert.equal((await errorFrom(tasks.updateTaskStatus, { params: { taskId: 'bad' }, body: { status: 'open' } })).status, 400);
});
