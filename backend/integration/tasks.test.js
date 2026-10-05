// Run only against a migrated disposable database:
// TEST_DATABASE_URL=postgres://... npm run test:integration
// Fixtures use random IDs; cleanup removes only rows created by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('tasks API against PostgreSQL', { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-only-access-secret';
  const { pool } = require('../src/config/db');
  const { signAccessToken } = require('../src/services/token.service');
  const app = require('../src/app');
  const users = Object.fromEntries(['creator', 'assignee', 'observer', 'admin', 'outsider', 'deleted'].map((role) => [role, randomUUID()]));
  const room = randomUUID();
  const otherRoom = randomUUID();
  const source = randomUUID();
  const foreignSource = randomUUID();
  const deletedSource = randomUUID();
  const events = [];
  app.set('io', { to(roomId) { return { emit(name, payload) { events.push({ roomId, name, payload }); } }; } });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    try {
      await pool.query('DELETE FROM rooms WHERE id = ANY($1::uuid[])', [[room, otherRoom]]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(users)]);
    } finally { await pool.end(); }
  });
  for (const [name, id] of Object.entries(users)) {
    await pool.query('INSERT INTO users (id, email, password_hash, display_name, deleted_at) VALUES ($1,$2,$3,$4,$5)',
      [id, `${id}@example.test`, 'not-a-login-credential', name, name === 'deleted' ? new Date() : null]);
  }
  for (const id of [room, otherRoom]) {
    await pool.query('INSERT INTO rooms (id, name, slug, created_by) VALUES ($1,$2,$3,$4)', [id, 'Task test room', `test-${id}`, users.admin]);
  }
  for (const [name, id] of Object.entries(users)) {
    await pool.query('INSERT INTO room_members (room_id,user_id,role) VALUES ($1,$2,$3)',
      [name === 'outsider' ? otherRoom : room, id, name === 'admin' ? 'admin' : 'member']);
  }
  for (const [id, roomId, deleted] of [[source, room, false], [foreignSource, otherRoom, false], [deletedSource, room, true]]) {
    await pool.query('INSERT INTO messages (id,room_id,sender_id,content,deleted_at) VALUES ($1,$2,$3,$4,$5)',
      [id, roomId, users.creator, 'Source message', deleted ? new Date() : null]);
  }
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}/api/tasks`;
  async function request(name, path = '', method = 'GET', body) {
    const response = await fetch(base + path, { method,
      headers: { 'content-type': 'application/json', ...(name ? { Authorization: `Bearer ${signAccessToken({ id: users[name] })}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  let task;
  await t.test('anonymous callers cannot list tasks', async () => {
    assert.equal((await request(null)).status, 401);
  });
  await t.test('members create tasks with assignee, source and room metadata', async () => {
    const response = await request('creator', '', 'POST', { roomId: room, title: '  Review launch  ', assigneeId: users.assignee, sourceMessageId: source, dueDate: '2028-02-29' });
    assert.equal(response.status, 201);
    task = response.body.data;
    assert.equal(task.title, 'Review launch');
    assert.equal(task.status, 'open');
    assert.equal(task.assignee_name, 'assignee');
    assert.equal(task.room_name, 'Task test room');
    assert.equal(task.due_date, '2028-02-29');
    assert.equal(events.at(-1).name, 'task:created');
    assert.equal(events.at(-1).roomId, room);
    // Emission follows commit: a separate connection can read the saved row.
    assert.equal((await pool.query('SELECT id FROM tasks WHERE id=$1', [task.id])).rowCount, 1);
  });
  await t.test('creation rejects other-room/deleted sources and inactive/nonmember assignees', async () => {
    const before = events.length;
    for (const patch of [
      { sourceMessageId: foreignSource }, { sourceMessageId: deletedSource },
      { assigneeId: users.outsider }, { assigneeId: users.deleted },
    ]) {
      const response = await request('creator', '', 'POST', { roomId: room, title: 'Forbidden task', ...patch });
      assert.equal(response.status, 400);
    }
    assert.equal((await request('outsider', '', 'POST', { roomId: room, title: 'No access' })).status, 403);
    assert.equal(events.length, before);
    assert.equal((await pool.query('SELECT id FROM tasks WHERE room_id=$1', [room])).rowCount, 1);
  });
  await t.test('status changes require creator, assignee or room admin membership', async () => {
    const before = events.length;
    assert.equal((await request('observer', `/${task.id}/status`, 'PATCH', { status: 'done' })).status, 403);
    assert.equal((await request('outsider', `/${task.id}/status`, 'PATCH', { status: 'done' })).status, 404);
    assert.equal(events.length, before);
    for (const [name, status] of [['assignee', 'in_progress'], ['creator', 'done'], ['admin', 'open']]) {
      const response = await request(name, `/${task.id}/status`, 'PATCH', { status });
      assert.equal(response.status, 200);
      assert.equal(response.body.data.status, status);
      assert.equal(events.at(-1).name, 'task:updated');
      assert.equal(events.at(-1).payload.task.status, status);
      task = response.body.data;
    }
  });
  await t.test('repeating a status does not change timestamps or broadcast again', async () => {
    const before = events.length;
    const response = await request('creator', `/${task.id}/status`, 'PATCH', { status: 'open' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.updated_at, task.updated_at);
    assert.equal(events.length, before);
  });
  await t.test('assigned task changes appear in the existing room digest', async () => {
    const response = await fetch(base.replace(/\/tasks$/, '') + `/digest/room/${room}`, {
      headers: { Authorization: `Bearer ${signAccessToken({ id: users.assignee })}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.data.items.some((item) => item.type === 'task' && item.id === task.id));
  });
  await t.test('lists apply membership, status and assignee filters', async () => {
    assert.equal((await request('outsider', '', 'POST', { roomId: otherRoom, title: 'Other room task' })).status, 201);
    assert.equal((await request('outsider', `/room/${room}`)).status, 403);
    assert.equal((await request('creator', `?roomId=${otherRoom}`)).status, 403);
    assert.equal((await request('creator')).body.data.tasks.length, 1);
    assert.equal((await request('assignee', '?assigneeId=me&status=open')).body.data.tasks[0].id, task.id);
    assert.equal((await request('creator', '?assigneeId=me')).body.data.tasks.length, 0);
    assert.equal((await request('creator', '?status=done')).body.data.tasks.length, 0);
    assert.equal((await request('creator', `/room/${room}?roomId=${otherRoom}`)).status, 400);
    assert.equal((await request('creator', '?status=invalid')).status, 400);
    assert.equal((await request('creator', `/${task.id}/status`, 'PATCH', { status: 'invalid' })).status, 400);
  });
  await t.test('pagination traverses equal microsecond timestamps without skipping rows', async () => {
    await pool.query(`INSERT INTO tasks (room_id,title,created_by,created_at)
      SELECT $1, 'Page task ' || n, $2, '2000-01-01T00:00:00.123456Z'::timestamptz
      FROM generate_series(1,55) n`, [room, users.creator]);
    const first = await request('creator');
    assert.equal(first.body.data.tasks.length, 50);
    assert.match(first.body.data.nextCursor, /\.123456Z\|/);
    const second = await request('creator', `?before=${encodeURIComponent(first.body.data.nextCursor)}`);
    assert.equal(second.body.data.tasks.length, 6);
    assert.equal(second.body.data.nextCursor, null);
    const all = [...first.body.data.tasks, ...second.body.data.tasks];
    assert.equal(new Set(all.map((item) => item.id)).size, 56);
    assert.ok(all.every((item) => item.room_id === room && !Object.hasOwn(item, 'cursor_time')));
  });
  await t.test('removing membership also revokes task creator mutation rights', async () => {
    await pool.query('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', [room, users.creator]);
    assert.equal((await request('creator', `/${task.id}/status`, 'PATCH', { status: 'done' })).status, 404);
    assert.deepEqual((await request('creator')).body.data.tasks, []);
  });
});
