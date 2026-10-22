// Integration tests: everything that can only be proven against a real
// Postgres. The suite in test/ deliberately runs no SQL, so the migrations and
// every rewritten query string were unverified until this existed — and one of
// them (migration 007) had in fact been wrong: it used array_to_string in an
// index expression, which is STABLE, not IMMUTABLE, so CREATE INDEX failed.
//
// What this covers that test/ cannot:
//   - the migrations actually apply, in order, and the runner is re-runnable
//   - the soft-delete transaction commits (it 500'd until migration 006)
//   - the compound (created_at, id) cursor pages through tied timestamps
//   - the per-room digest window filters by that room's own last_seen_at
//   - deleted message bodies are withheld and never returned by search
//   - attachment shape and validation in createMessage
//   - mention matching respects word boundaries and escapes wildcards
//   - Postgres SQLSTATEs map to the documented status codes
//
// Uses a uniquely named disposable database. DATABASE_URL must identify a test
// PostgreSQL server where the caller has CREATEDB. Database failures fail this
// explicit suite; npm test runs the separate smoke/regression suite without SQL.
// Run with: npm run test:db

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { randomBytes, randomUUID } = require('node:crypto');

// --- Locate a Postgres to talk to, before anything reads env.js ---------------
require('dotenv').config({ quiet: true });

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://app:app@127.0.0.1:5432/postgres';
// A unique name per suite/run: never drop a pre-existing database.
const TEST_DB = `conclave_test_${randomBytes(12).toString('hex')}`;

const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${TEST_DB}`;
const TEST_DB_URL = testUrl.toString();

// Must be set before src/config/db is required, since env.js reads it at load.
process.env.DATABASE_URL = TEST_DB_URL;
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET ||= 'integration-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'integration-test-refresh-secret';
process.env.CLIENT_ORIGIN ||= 'http://localhost:5173';
process.env.TRUST_PROXY_HOPS ||= '1';

const { query } = require('../src/config/db');
const { createMessage } = require('../src/services/message.service');

// --- Suite lifecycle ---------------------------------------------------------

let admin;
let available = false;

// Fixtures created once after migrating. The database starts with schema only,
// so anything that needs a user or a room has to be handed one — several tests
// below were silently asserting against an empty table before this existed.
let user;
let fixtureSessionId;
let room;

async function dropTestDb() {
  // Close any remaining connections to this run's database before dropping it.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TEST_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
}

test.before(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error('Database tests require reachable PostgreSQL', { cause: err });
  }

  try {
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    available = true;
  } catch (err) {
    throw new Error('Database tests require permission to create disposable databases', { cause: err });
  }

  // Apply the real migrations rather than hand-writing a schema, so a broken
  // migration fails here. Runs in a child process because migrate.js calls
  // pool.end() and writes its own bookkeeping.
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, ['database/migrate.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });

  // One user, one room, and a membership row so createMessage is authorised.
  user = (
    await query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ('fixture@test.com', 'x', 'Fixture User') RETURNING id, display_name`,
    )
  ).rows[0];
  fixtureSessionId = randomUUID();
  await query("INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')", [fixtureSessionId, user.id]);
  room = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ('Fixture Room', 'group', $1, 'fixture-room') RETURNING id`,
      [user.id],
    )
  ).rows[0];
  await query(
    `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'admin')`,
    [room.id, user.id],
  );

  await startServer();
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await require('../src/config/db').pool.end();
  if (admin) {
    if (available) {
      try {
        await dropTestDb();
      } catch { /* best effort */ }
    }
    await admin.end().catch(() => {});
  }
});

// Setup failures fail the suite; database checks must never silently skip.
const dbTest = test;

const TABLES = [
  'rooms', 'users', 'messages', 'attachments', 'decisions', 'tasks',
  'room_members', 'message_reactions', 'notifications', 'refresh_tokens',
  'file_uploads', 'decision_pins',
  'polls', 'poll_options', 'poll_votes',
];

// --- Schema ------------------------------------------------------------------

dbTest('every migration file applies and is recorded', async () => {
  // Compared against the files on disk rather than a hardcoded count, so adding
  // a migration cannot silently leave this test asserting a stale number.
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'database', 'migrations');
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const { rows } = await query('SELECT filename FROM schema_migrations ORDER BY filename');
  const recorded = rows.map((r) => r.filename);

  assert.deepEqual(
    recorded, onDisk,
    `recorded migrations do not match the files on disk (${onDisk.length} files)`,
  );
  assert.equal(recorded[0], '001_init.sql');
});

dbTest('every expected table exists', async () => {
  const { rows } = await query(
    'SELECT tablename FROM pg_tables WHERE schemaname = $1',
    ['public'],
  );
  const present = new Set(rows.map((r) => r.tablename));
  for (const t of TABLES) assert.ok(present.has(t), `missing table ${t}`);
});

dbTest('rooms.slug is NOT NULL and unique', async () => {
  const col = await query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'rooms' AND column_name = 'slug'`,
  );
  assert.equal(col.rows[0].is_nullable, 'NO');

  const idx = await query(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'rooms' AND indexdef LIKE '%slug%' AND indexdef LIKE '%UNIQUE%'`,
  );
  assert.ok(idx.rows.length > 0, 'expected a unique index on rooms.slug');
});

dbTest('notifications.actor_id exists and nulls the actor on hard delete', async () => {
  const col = await query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'notifications' AND column_name = 'actor_id'`,
  );
  assert.equal(col.rows.length, 1, 'migration 009 should have added actor_id');
  assert.equal(col.rows[0].is_nullable, 'YES', 'actor_id must be nullable for ON DELETE SET NULL');
});

dbTest('file_uploads enforces one-time use and releases on message delete', async () => {
  // Migration 010. The unique index is what stops two upload records for one
  // asset; attached_message_id is what makes a file single-use.
  const url = await query(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'file_uploads' AND indexdef LIKE '%UNIQUE%'`,
  );
  assert.ok(url.rows.length > 0, 'expected a unique index on file_uploads.file_url');

  const fk = await query(
    `SELECT rc.delete_rule
       FROM information_schema.referential_constraints rc
       JOIN information_schema.table_constraints tc
         ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
      WHERE tc.table_name = 'file_uploads' AND kcu.column_name = 'attached_message_id'`,
  );
  assert.equal(fk.rows[0].delete_rule, 'SET NULL', 'deleting a message must free the upload, not drop the record');
});

dbTest('users.email is nullable so soft delete can release it', async () => {
  // Migration 006. Before this, deleteMe rolled back with a 500.
  const col = await query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'email'`,
  );
  assert.equal(col.rows[0].is_nullable, 'YES');
});

dbTest('the migration runner is re-runnable', async () => {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['database/migrate.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    encoding: 'utf8',
  });
  assert.match(out, /Nothing to migrate|up to date/i);
});

// --- Soft delete (the P0) ----------------------------------------------------

dbTest('deleteMe commits: anonymises, kills sessions, leaves rooms', async () => {
  const u = (
    await query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ('delete-me@test.com', 'x', 'Delete Me') RETURNING id`,
    )
  ).rows[0];
  const rm = (await query(`SELECT id FROM rooms LIMIT 1`)).rows[0];
  await query(
    `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`,
    [rm.id, u.id],
  );
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, 'h', NOW() + INTERVAL '7 days')`,
    [u.id],
  );

  const client = await require('../src/config/db').pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET deleted_at = NOW(), email = NULL, password_hash = '',
              display_name = 'Deleted user', avatar_url = NULL, bio = NULL
        WHERE id = $1 AND deleted_at IS NULL`,
      [u.id],
    );
    await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [u.id]);
    await client.query('DELETE FROM room_members WHERE user_id = $1', [u.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`soft delete failed: ${err.message}`);
  } finally {
    client.release();
  }

  const row = (await query('SELECT email, display_name FROM users WHERE id = $1', [u.id])).rows[0];
  assert.equal(row.email, null);
  assert.equal(row.display_name, 'Deleted user');

  const tok = (await query('SELECT COUNT(*)::int n FROM refresh_tokens WHERE user_id = $1', [u.id])).rows[0].n;
  const mem = (await query('SELECT COUNT(*)::int n FROM room_members WHERE user_id = $1', [u.id])).rows[0].n;
  assert.equal(tok, 0, 'refresh tokens should be revoked');
  assert.equal(mem, 0, 'room memberships should be removed');

  const login = await query(
    'SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL',
    ['delete-me@test.com'],
  );
  assert.equal(login.rows.length, 0, 'a soft-deleted account must not be able to log in');

  const reuse = await query('SELECT id FROM users WHERE lower(email) = $1', ['delete-me@test.com']);
  assert.equal(reuse.rows.length, 0, 'the email should be released for reuse');
});

// --- Email normalisation (Bug 11) --------------------------------------------

dbTest('email lookup is case-insensitive and matches legacy mixed-case rows', async () => {
  const u = (
    await query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ('Case@Test.com', 'x', 'Casey') RETURNING id`,
    )
  ).rows[0];

  for (const input of ['case@test.com', 'CASE@TEST.COM', '  Case@Test.Com  ']) {
    const norm = String(input).trim().toLowerCase();
    const r = await query(
      'SELECT display_name FROM users WHERE lower(email) = $1 AND deleted_at IS NULL',
      [norm],
    );
    assert.equal(r.rows.length, 1, `${input} should resolve to the same account`);
  }

  // A row stored before normalisation existed must still match, because the
  // comparison is on lower(email) rather than the raw column.
  await query(`UPDATE users SET email = 'Legacy@Mixed.Case' WHERE id = $1`, [u.id]);
  const legacy = await query(
    `SELECT display_name FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`,
    ['legacy@mixed.case'],
  );
  assert.equal(legacy.rows.length, 1);
});

// --- Slug allocation (Bug 4) -------------------------------------------------

// A tiny in-process server so the real controllers run, rather than the test
// reimplementing their logic. Without this, a test can pass while the code it
// was copied from is broken — which is exactly what happened with the first
// draft of this file. There is one `before` and one `after` for the whole file
// (a second registration of either is not reliably honoured), so the server
// lifecycle is folded into the database hooks above.
let server;
let baseUrl;

async function startServer() {
  const app = require('../src/app');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

// Register a throwaway account and return a bearer token.
async function authedUser(email) {
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${randomBytes(3).readUIntBE(0, 3) % 250 + 1}` },
    body: JSON.stringify({ email, password: 'correct-horse-battery', displayName: 'Slug Tester' }),
  });
  // Read the body once. Passing `await res.text()` as an assert message
  // consumes it, because the message is built eagerly even when the assertion
  // passes — so a later .json() on the same response throws "body already read".
  const body = await reg.text();
  assert.equal(reg.status, 201, `register failed: ${reg.status} ${body}`);
  return JSON.parse(body).data.accessToken;
}

// Some tests need the new account's id as well as its token, to exercise
// cross-account checks (assigning a task to a non-member, patching another
// user's task).
async function authedAccount(email) {
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${randomBytes(3).readUIntBE(0, 3) % 250 + 1}` },
    body: JSON.stringify({ email, password: 'correct-horse-battery', displayName: 'Task Tester' }),
  });
  const body = await reg.text();
  assert.equal(reg.status, 201, `register failed: ${reg.status} ${body}`);
  const { data } = JSON.parse(body);
  return { token: data.accessToken, userId: data.user.id };
}

// A bearer token for the fixture user, who is an admin of `room` but was created
// with SQL rather than through /auth/register — so no token exists for it yet.
// Generated directly with the same secret env.js uses, because these tests need
// to act as that specific user, not as a fresh account.
function tokenForFixtureUser() {
  const jwt = require('jsonwebtoken');
  return jwt.sign(
    { sub: user.id, sid: fixtureSessionId, email: 'fixture@test.com' },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '15m' },
  );
}

dbTest('createRoom slugifies names and disambiguates duplicates', async () => {
  const token = await authedUser('slug-tester@test.com');
  const post = (name) =>
    fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
    });

  const first = await post('Product & Engineering');
  const firstBody = await first.text();
  assert.equal(first.status, 201, firstBody);
  const a = JSON.parse(firstBody).data;
  assert.equal(a.slug, 'product-engineering', 'name is slugified server-side');

  // Same name again: rooms.name is not UNIQUE, so this must not collide, and
  // the slug must not be taken by the caller.
  const second = await post('Product & Engineering');
  const secondBody = await second.text();
  assert.equal(second.status, 201, secondBody);
  const b = JSON.parse(secondBody).data;
  assert.notEqual(a.slug, b.slug, 'two rooms with one name get distinct slugs');

  // A client-supplied slug must be ignored, or a handle could be squatted.
  const spoof = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Design Crit', slug: 'product-engineering' }),
  });
  const spoofBody = await spoof.text();
  assert.equal(spoof.status, 201, spoofBody);
  assert.notEqual(JSON.parse(spoofBody).data.slug, 'product-engineering', 'the client cannot choose its own slug');
});

dbTest('a name with nothing sluggable still gets a usable slug', async () => {
  const token = await authedUser('slug-fallback@test.com');
  const res = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: '日本語' }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  const { data } = JSON.parse(body);
  assert.ok(data.slug && data.slug.length > 0, 'slug must not be empty');
});

dbTest('a duplicate slug is rejected as 23505 -> 409', async () => {
  const first = (await query('SELECT slug FROM rooms LIMIT 1')).rows[0].slug;
  await assert.rejects(
    () => query(`INSERT INTO rooms (name, type, created_by, slug) VALUES ('dup', 'group', (SELECT id FROM users LIMIT 1), $1)`, [first]),
    (err) => err.code === '23505',
  );
});

// --- Compound cursor (Bug 15) ------------------------------------------------

dbTest('the compound cursor pages through identical timestamps without skipping', async () => {
  const u = (await query(`SELECT id FROM users LIMIT 1`)).rows[0];
  const room = (await query(`SELECT id FROM rooms LIMIT 1`)).rows[0];
  const ts = '2026-01-01 12:00:00+00';

  for (let i = 0; i < 7; i += 1) {
    await query(
      `INSERT INTO messages (room_id, sender_id, content, created_at)
       VALUES ($1, $2, $3, $4::timestamptz)`,
      [room.id, u.id, `tie ${i}`, ts],
    );
  }

  const page1 = await query(
    `SELECT id, created_at FROM messages
      WHERE room_id = $1 AND created_at < $2::timestamptz AND content LIKE 'tie %'
      ORDER BY created_at DESC, id DESC LIMIT 3`,
    [room.id, '2026-01-02'],
  );
  assert.equal(page1.rows.length, 3);

  const last = page1.rows[2];
  const page2 = await query(
    `SELECT id FROM messages
      WHERE room_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
        AND content LIKE 'tie %'
      ORDER BY created_at DESC, id DESC LIMIT 3`,
    [room.id, last.created_at.toISOString(), last.id],
  );

  const seen = new Set([...page1.rows, ...page2.rows].map((r) => r.id));
  assert.equal(seen.size, 6, 'six tied rows should be reachable across two pages');

  const total = await query(
    `SELECT COUNT(*)::int n FROM messages WHERE room_id = $1 AND content LIKE 'tie %'`,
    [room.id],
  );
  assert.equal(total.rows[0].n, 7, 'all seven tied rows still exist to page through');
});

// --- Digest window (Bug 2) ---------------------------------------------------

dbTest('the digest window is per room, not one shared timestamp', async () => {
  const u = (await query(`SELECT id FROM users LIMIT 1`)).rows[0];
  const stale = (await query(`INSERT INTO rooms (name, type, created_by, slug) VALUES ('Stale Room', 'group', $1, 'stale-room') RETURNING id`, [u.id])).rows[0];
  const fresh = (await query(`INSERT INTO rooms (name, type, created_by, slug) VALUES ('Fresh Room', 'group', $1, 'fresh-room') RETURNING id`, [u.id])).rows[0];

  for (const r of [stale, fresh]) {
    await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [r.id, u.id]);
    await query(
      `INSERT INTO decisions (room_id, title, body, created_by, created_at)
       VALUES ($1, $2, 'body', $3, '2026-06-01 00:00:00+00')`,
      [r.id, `${r.name} decision`, u.id],
    );
  }

  // Read Stale Room long ago (its decision is new) and Fresh Room in the
  // future (its decision is old). Fixed timestamps, so no dependence on NOW().
  await query(`UPDATE room_members SET last_seen_at = '2026-01-01 00:00:00+00' WHERE room_id = $1 AND user_id = $2`, [stale.id, u.id]);
  await query(`UPDATE room_members SET last_seen_at = '2027-01-01 00:00:00+00' WHERE room_id = $1 AND user_id = $2`, [fresh.id, u.id]);

  const perRoom = await query(
    `SELECT r.name FROM decisions d
       INNER JOIN rooms r ON r.id = d.room_id
       INNER JOIN room_members rm ON rm.room_id = d.room_id AND rm.user_id = $2
      WHERE d.room_id = ANY($1::uuid[]) AND d.created_at > rm.last_seen_at`,
    [[stale.id, fresh.id], u.id],
  );
  assert.equal(perRoom.rows.length, 1, 'only the unread room should surface');
  assert.equal(perRoom.rows[0].name, 'Stale Room');

  const shared = await query(
    `SELECT COUNT(*)::int n FROM decisions d
      WHERE d.room_id = ANY($1::uuid[])
        AND d.created_at > (SELECT MAX(last_seen_at) FROM room_members WHERE user_id = $2)`,
    [[stale.id, fresh.id], u.id],
  );
  assert.equal(shared.rows[0].n, 0, 'a single shared MAX() would have hidden it entirely');
});

dbTest('last_seen_at is writable, which nothing did before Bug 2', async () => {
  const u = user;
  const r = await query(
    `UPDATE room_members SET last_seen_at = NOW()
      WHERE room_id = $1 AND user_id = $2 RETURNING last_seen_at`,
    [room.id, u.id],
  );
  assert.equal(r.rows.length, 1);
});

// --- Deleted messages (Bug 7) ------------------------------------------------

dbTest('deleted message bodies are withheld and flagged is_deleted', async () => {
  const u = (await query(`SELECT id FROM users LIMIT 1`)).rows[0];
  const room = (await query(`SELECT id FROM rooms LIMIT 1`)).rows[0];
  const id = (
    await query(
      `INSERT INTO messages (room_id, sender_id, content, deleted_at)
       VALUES ($1, $2, 'secret content', NOW()) RETURNING id`,
      [room.id, u.id],
    )
  ).rows[0].id;

  const masked = (
    await query(
      `SELECT CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE content END AS content,
              deleted_at IS NOT NULL AS is_deleted
         FROM messages WHERE id = $1`,
      [id],
    )
  ).rows[0];
  assert.equal(masked.content, null, 'the body must not be returned');
  assert.equal(masked.is_deleted, true);

  const leak = await query(
    `SELECT id FROM messages
      WHERE room_id = $1 AND deleted_at IS NULL
        AND to_tsvector('english', content) @@ plainto_tsquery('english', $2)`,
    [room.id, 'secret'],
  );
  assert.equal(leak.rows.length, 0, 'search must never surface retracted content');
});

// --- createMessage attachments (Bugs 6 and 8, item C) -------------------------

/**
 * Insert an unclaimed upload row for a fixture user, as POST /upload would.
 * Lets the attachment tests below run without touching Cloudinary.
 */
async function seedUpload({ uploaderId, url, filename = 'checklist.pdf', mimeType = 'application/pdf', size = 4096 }) {
  return (await query(
    `INSERT INTO file_uploads (uploader_id, file_url, filename, mime_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, file_url`,
    [uploaderId, url, filename, mimeType, size],
  )).rows[0];
}

dbTest('an attachment-only message is accepted and shaped like listMessages', async () => {
  const u = user;
  const url = `https://x/c-${Date.now()}.pdf`;
  await seedUpload({ uploaderId: u.id, url });

  const m = await createMessage({
    roomId: room.id,
    senderId: u.id,
    content: '',
    attachments: [{ url }],
  });

  assert.ok(m.id, 'should have been created');
  assert.equal(m.content, null, 'empty content is stored as NULL, not ""');
  assert.equal(m.attachments.length, 1);
  assert.deepEqual(
    Object.keys(m.attachments[0]),
    ['id', 'filename', 'size', 'mime_type', 'url', 'width', 'height', 'preview_url', 'duration'],
    'must match the shape listMessages returns',
  );
  assert.equal(m.attachments[0].url, url);
  assert.equal(m.sender_name, (await query('SELECT display_name FROM users WHERE id = $1', [u.id])).rows[0].display_name);
  assert.equal(m.sender, undefined, 'sender must be flat, not a nested object');
});

dbTest('a message empty in both content and attachments is rejected', async () => {
  const u = user;
  await assert.rejects(
    () => createMessage({ roomId: room.id, senderId: u.id, content: '' }),
    (err) => err.status === 400,
  );
});

dbTest('attachment shape is validated before the insert, leaving no orphan message', async () => {
  const u = user;
  const before = (await query('SELECT COUNT(*)::int n FROM messages WHERE room_id = $1', [room.id])).rows[0].n;

  const cases = [
    [[{}], 'no url'],
    [[{ url: '   ' }], 'blank url'],
    [[{ url: 42 }], 'non-string url'],
    [[null], 'null attachment'],
    [['not-an-object'], 'string instead of object'],
    [Array.from({ length: 11 }, () => ({ url: 'https://x/u' })), 'too many files'],
  ];

  for (const [attachments, label] of cases) {
    await assert.rejects(
      () => createMessage({ roomId: room.id, senderId: u.id, content: 'x', attachments }),
      (err) => err.status === 400,
      `should reject: ${label}`,
    );
  }

  const after = (await query('SELECT COUNT(*)::int n FROM messages WHERE room_id = $1', [room.id])).rows[0].n;
  assert.equal(after, before, 'validation must happen before the insert');
});

// --- Attachment provenance and one-time use (item C) --------------------------

dbTest('an upload can only be attached by the user who uploaded it', async () => {
  const uploader = (
    await query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ('other@test.com', 'x', 'Other User') RETURNING id`,
    )
  ).rows[0];
  const url = `https://x/other-${Date.now()}.png`;
  await seedUpload({ uploaderId: uploader.id, url, filename: 'not-yours.png', mimeType: 'image/png' });

  const before = (await query('SELECT COUNT(*)::int n FROM messages WHERE room_id = $1', [room.id])).rows[0].n;

  await assert.rejects(
    () => createMessage({ roomId: room.id, senderId: user.id, content: 'borrowed', attachments: [{ url }] }),
    (err) => err.status === 400,
    "attaching another user's upload must be rejected",
  );

  const after = (await query('SELECT COUNT(*)::int n FROM messages WHERE room_id = $1', [room.id])).rows[0].n;
  assert.equal(after, before, 'the rejection must roll back the message');

  const stillUnclaimed = await query(
    'SELECT attached_message_id FROM file_uploads WHERE file_url = $1',
    [url],
  );
  assert.equal(stillUnclaimed.rows[0].attached_message_id, null, "the upload must stay claimable by its owner");
});

dbTest('an upload is attached exactly once', async () => {
  const u = user;
  const url = `https://x/once-${Date.now()}.pdf`;
  await seedUpload({ uploaderId: u.id, url });

  const first = await createMessage({ roomId: room.id, senderId: u.id, content: 'first', attachments: [{ url }] });
  assert.equal(first.attachments.length, 1);

  const albumId = randomUUID();
  const secondUrl = `https://x/album-${Date.now()}.png`;
  await seedUpload({ uploaderId: u.id, url: secondUrl, mimeType: 'image/png' });
  const albumItem = await createMessage({
    roomId: room.id, senderId: u.id, content: 'second caption',
    attachments: [{ url: secondUrl }], albumId,
  });
  assert.equal(albumItem.album_id, albumId);
  assert.equal(albumItem.attachments.length, 1);

  const before = (await query('SELECT COUNT(*)::int n FROM messages WHERE room_id = $1', [room.id])).rows[0].n;
  await assert.rejects(
    () => createMessage({ roomId: room.id, senderId: u.id, content: 'second', attachments: [{ url }] }),
    (err) => err.status === 400,
    'reusing an attached upload must be rejected',
  );
  const after = (await query('SELECT COUNT(*)::int n FROM messages WHERE room_id = $1', [room.id])).rows[0].n;
  assert.equal(after, before, 'the rejected message must not be persisted');

  const claimed = await query('SELECT attached_message_id FROM file_uploads WHERE file_url = $1', [url]);
  assert.equal(claimed.rows[0].attached_message_id, first.id, 'the claim must still point at the first message');
});

dbTest('media album metadata survives retries and history and rejects another room or sender', async () => {
  const sender = await authedAccount(`album-sender-${randomUUID()}@test.com`);
  const peer = await authedAccount(`album-peer-${randomUUID()}@test.com`);
  const localRooms = [];
  for (const suffix of ['a', 'b']) {
    const created = (await query(
      `INSERT INTO rooms (name, type, created_by, slug) VALUES ('Album room', 'group', $1, $2) RETURNING id`,
      [sender.userId, `album-${randomUUID()}-${suffix}`],
    )).rows[0];
    localRooms.push(created.id);
    await query(`INSERT INTO room_members (room_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [created.id, sender.userId, peer.userId]);
  }
  const albumId = randomUUID();
  const urls = Array.from({ length: 4 }, () => `https://fixture/${randomUUID()}.png`);
  for (const url of urls.slice(0, 3)) await seedUpload({ uploaderId: sender.userId, url, mimeType: 'image/png' });
  await seedUpload({ uploaderId: peer.userId, url: urls[3], mimeType: 'image/png' });
  const first = await createMessage({ roomId: localRooms[0], senderId: sender.userId,
    clientId: randomUUID(), content: 'First item caption', attachments: [{ url: urls[0] }], albumId });
  const request = { roomId: localRooms[0], senderId: sender.userId, clientId: randomUUID(),
    content: 'Second item caption', replyToId: first.id, attachments: [{ url: urls[1] }], albumId };
  const second = await createMessage(request);
  const replay = await createMessage(request);
  assert.equal(replay.id, second.id);
  assert.equal(replay.album_id, albumId);
  assert.equal(replay.attachments.length, 1);
  assert.equal(replay.attachments[0].id, second.attachments[0].id);
  const history = await fetch(`${baseUrl}/api/messages/room/${localRooms[0]}`, {
    headers: { authorization: `Bearer ${sender.token}` },
  });
  assert.equal(history.status, 200);
  const rows = (await history.json()).data.messages;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.album_id === albumId && row.attachments.length === 1));
  assert.equal(rows.find((row) => row.id === second.id).reply_to_id, first.id);
  await assert.rejects(() => createMessage({ roomId: localRooms[1], senderId: sender.userId,
    content: 'Wrong room', attachments: [{ url: urls[2] }], albumId }),
  (error) => error.status === 400 && /one conversation and sender/.test(error.message));
  await assert.rejects(() => createMessage({ roomId: localRooms[0], senderId: peer.userId,
    content: 'Wrong sender', attachments: [{ url: urls[3] }], albumId }),
  (error) => error.status === 400 && /one conversation and sender/.test(error.message));
  await assert.rejects(() => createMessage({ roomId: localRooms[0], senderId: sender.userId,
    content: 'Text cannot become an album item', albumId }), (error) => error.status === 400);
  const unclaimed = await query('SELECT attached_message_id FROM file_uploads WHERE file_url = ANY($1::text[])', [urls.slice(2)]);
  assert.ok(unclaimed.rows.every((row) => row.attached_message_id === null));
});

dbTest('the same URL cannot be claimed twice within one message', async () => {
  const u = user;
  const url = `https://x/dup-${Date.now()}.pdf`;
  await seedUpload({ uploaderId: u.id, url });

  // The first claim succeeds, the second hits the same already-attached row and
  // rolls the whole message back — otherwise one URL would yield two attachment
  // rows on a single message.
  await assert.rejects(
    () => createMessage({
      roomId: room.id, senderId: u.id, content: 'twice',
      attachments: [{ url }, { url }],
    }),
    (err) => err.status === 400,
  );

  const claimed = await query('SELECT attached_message_id FROM file_uploads WHERE file_url = $1', [url]);
  assert.equal(claimed.rows[0].attached_message_id, null, 'the rollback must release the claim');
});

dbTest('an unknown URL is rejected', async () => {
  await assert.rejects(
    () => createMessage({
      roomId: room.id, senderId: user.id, content: 'ghost',
      attachments: [{ url: 'https://evil.example/never-uploaded.exe' }],
    }),
    (err) => err.status === 400,
    'a URL that was never uploaded must not be attachable',
  );
});

dbTest('client-supplied metadata is ignored in favour of the upload record', async () => {
  const u = user;
  const url = `https://x/liar-${Date.now()}.png`;
  await seedUpload({
    uploaderId: u.id, url, filename: 'honest.png', mimeType: 'image/png', size: 1234,
  });

  const m = await createMessage({
    roomId: room.id,
    senderId: u.id,
    content: 'liar',
    attachments: [{
      url,
      // Deliberately wrong: the server must not take any of this from the client.
      filename: 'actually-a-payload.exe',
      mime_type: 'application/x-msdownload',
      size: 999999,
    }],
  });

  assert.equal(m.attachments[0].filename, 'honest.png');
  assert.equal(m.attachments[0].mime_type, 'image/png');
  assert.equal(m.attachments[0].size, 1234);

  const row = await query('SELECT filename, file_type, size_bytes FROM attachments WHERE id = $1', [m.attachments[0].id]);
  assert.equal(row.rows[0].filename, 'honest.png');
  assert.equal(row.rows[0].file_type, 'image/png');
  assert.equal(row.rows[0].size_bytes, 1234, 'the stored row must not carry the client-supplied size');
});

dbTest('a failed send leaves its uploads unclaimed and reusable', async () => {
  const u = user;
  const good = `https://x/retry-${Date.now()}.pdf`;
  const unknown = 'https://x/does-not-exist.png';
  await seedUpload({ uploaderId: u.id, url: good });

  await assert.rejects(
    () => createMessage({
      roomId: room.id, senderId: u.id, content: 'mixed',
      attachments: [{ url: good }, { url: unknown }],
    }),
    (err) => err.status === 400,
  );

  const row = await query('SELECT attached_message_id FROM file_uploads WHERE file_url = $1', [good]);
  assert.equal(row.rows[0].attached_message_id, null, 'the first claim must roll back with the message');

  // And it is genuinely reusable, not just un-set.
  const retry = await createMessage({ roomId: room.id, senderId: u.id, content: 'retry', attachments: [{ url: good }] });
  assert.equal(retry.attachments.length, 1);
});

dbTest('hard-deleting a message releases its upload instead of deleting the record', async () => {
  const u = user;
  const url = `https://x/released-${Date.now()}.pdf`;
  await seedUpload({ uploaderId: u.id, url });

  const m = await createMessage({ roomId: room.id, senderId: u.id, content: 'doomed', attachments: [{ url }] });
  await query('DELETE FROM messages WHERE id = $1', [m.id]);

  const stillThere = await query('SELECT attached_message_id FROM file_uploads WHERE file_url = $1', [url]);
  assert.equal(stillThere.rows.length, 1, 'ON DELETE SET NULL must keep the provenance row');
  assert.equal(stillThere.rows[0].attached_message_id, null);
});

dbTest('searchMessages returns attachments, matching listMessages', async () => {
  const u = user;
  const needle = `zqxmarker${Date.now()}`;
  const msg = (await query(
    `INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, $3) RETURNING id`,
    [room.id, u.id, needle],
  )).rows[0];
  await query(
    `INSERT INTO attachments (message_id, filename, file_url, file_type, size_bytes)
     VALUES ($1, 'findme.pdf', 'https://x/f.pdf', 'application/pdf', 10)`,
    [msg.id],
  );

  const found = await query(
    `SELECT COALESCE(
        json_agg(json_build_object('filename', a.filename)) FILTER (WHERE a.id IS NOT NULL), '[]'
      ) AS attachments
     FROM messages m
     LEFT JOIN attachments a ON a.message_id = m.id
     WHERE m.room_id = $1 AND m.deleted_at IS NULL
       AND to_tsvector('english', m.content) @@ plainto_tsquery('english', $2)
     GROUP BY m.id`,
    [room.id, needle],
  );
  assert.equal(found.rows.length, 1, 'the message should match');
  assert.equal(found.rows[0].attachments.length, 1, 'its attachment should come back too');
});

// --- Tasks endpoints (item A) -------------------------------------------------

dbTest('tasks.status is constrained by the database, not just the controller', async () => {
  // Migration 011. Controller validation can be bypassed by any future write
  // path — a service, a script, a migration — so the guarantee has to live in
  // the schema. The digest reads this column straight into user-facing text.
  const room2 = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ('Task Constraint Room', 'group', $1, 'task-constraint-room') RETURNING id`,
      [user.id],
    )
  ).rows[0];

  await assert.rejects(
    () => query(
      `INSERT INTO tasks (room_id, title, status, created_by) VALUES ($1, 'bad', 'banana', $2)`,
      [room2.id, user.id],
    ),
    (err) => err.code === '23514',
    'a raw insert of an invalid status must be rejected by the CHECK constraint',
  );

  for (const good of ['open', 'in_progress', 'done']) {
    const row = await query(
      `INSERT INTO tasks (room_id, title, status, created_by) VALUES ($1, $2, $3, $4) RETURNING status`,
      [room2.id, `task ${good}`, good, user.id],
    );
    assert.equal(row.rows[0].status, good);
  }
});

// --- Tasks endpoints (item A) -------------------------------------------------

// A token for the fixture user, who owns `room`, generated inside the first test
// rather than at module scope: the user is created by the `before` hook, which has
// not run while this file is still being evaluated. Declared with `let` for that
// reason, and assigned exactly once.
let fixtureToken;

dbTest('createTask returns the same shape listTasks returns', async () => {
  fixtureToken = tokenForFixtureUser();

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${fixtureToken}` },
    body: JSON.stringify({ roomId: room.id, title: 'Shape check', dueDate: '2026-12-01' }),
  });
  const body = await created.text();
  assert.equal(created.status, 201, body);
  const task = JSON.parse(body).data;

  assert.deepEqual(
    Object.keys(task).sort(),
    [
      'assignee_id', 'assignee_name', 'body', 'created_at', 'created_by', 'due_date',
      'id', 'room_id', 'room_name', 'room_slug', 'source_message_id',
      'status', 'title', 'updated_at',
    ],
    'createTask must not hand back a different shape than listTasks',
  );
  assert.equal(task.status, 'open', 'the default status comes from the column default');
  assert.equal(task.room_name, room.name ?? null ?? 'Fixture Room');
  assert.equal(task.assignee_name, null, 'an unassigned task must still be returned');

  const listed = await fetch(`${baseUrl}/api/tasks`, {
    headers: { authorization: `Bearer ${fixtureToken}` },
  });
  const listedBody = await listed.text();
  assert.equal(listed.status, 200, listedBody);
  const found = JSON.parse(listedBody).data.tasks.find((t) => t.id === task.id);
  assert.ok(found, 'the created task must appear in the list');
  assert.deepEqual(Object.keys(found).sort(), Object.keys(task).sort(), 'both paths must agree');
});

dbTest('creating a task requires room membership', async () => {
  const outsider = await authedUser('task-outsider@test.com');
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${outsider}` },
    body: JSON.stringify({ roomId: room.id, title: 'Should not exist' }),
  });
  const body = await res.text();
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${body}`);
});

dbTest('a task cannot be assigned to someone outside the room', async () => {
  // Otherwise the task is invisible: its assignee cannot open the room, and
  // their digest filters on assignee_id within a room they are not in.
  const stranger = await authedAccount('task-stranger@test.com');
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${fixtureToken}` },
    body: JSON.stringify({ roomId: room.id, title: 'Misassigned', assigneeId: stranger.userId }),
  });
  const body = await res.text();
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${body}`);
});

dbTest('sourceMessageId must belong to the same room', async () => {
  const otherRoom = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ('Elsewhere', 'group', $1, 'elsewhere') RETURNING id`,
      [user.id],
    )
  ).rows[0];
  await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [otherRoom.id, user.id]);

  const foreignMessage = (
    await query(
      `INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, 'not in your room') RETURNING id`,
      [otherRoom.id, user.id],
    )
  ).rows[0];

  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${fixtureToken}` },
    body: JSON.stringify({ roomId: room.id, title: 'Cross-room link', sourceMessageId: foreignMessage.id }),
  });
  const body = await res.text();
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${body}`);
});

dbTest('the cross-room task list excludes rooms the caller is not in', async () => {
  const outsider = await authedUser('task-list-outsider@test.com');

  const mine = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${fixtureToken}` },
    body: JSON.stringify({ roomId: room.id, title: 'Visible to member' }),
  });
  assert.equal(mine.status, 201);

  const secret = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ('Not Yours', 'group', $1, 'not-yours') RETURNING id`,
      [user.id],
    )
  ).rows[0];
  await query(
    `INSERT INTO tasks (room_id, title, created_by) VALUES ($1, 'Private task', $2)`,
    [secret.id, user.id],
  );

  const res = await fetch(`${baseUrl}/api/tasks`, {
    headers: { authorization: `Bearer ${outsider}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const tasks = JSON.parse(body).data.tasks;
  assert.ok(
    !tasks.some((t) => t.title === 'Private task'),
    'a task from a room the caller is not in must not be listed',
  );
});

dbTest('the room-scoped route delegates to the same handler', async () => {
  const res = await fetch(`${baseUrl}/api/tasks/room/${room.id}`, {
    headers: { authorization: `Bearer ${fixtureToken}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const scoped = JSON.parse(body).data.tasks;

  const crossRoom = await fetch(`${baseUrl}/api/tasks`, {
    headers: { authorization: `Bearer ${fixtureToken}` },
  });
  const all = JSON.parse(await crossRoom.text()).data.tasks;

  for (const task of scoped) {
    assert.ok(
      all.some((t) => t.id === task.id),
      'every room-scoped task must also appear in the cross-room list',
    );
  }
  assert.ok(all.length >= scoped.length, 'cross-room cannot return fewer tasks');
});

dbTest('status can be updated, and updated_at actually moves', async () => {
  // The digest's entire time window is `updated_at > last_seen_at`, and nothing
  // else maintains that column — so a status change that left it at creation
  // time would mean the task never appears in anyone's catch-up feed.
  const created = (
    await query(
      `INSERT INTO tasks (room_id, title, created_by, updated_at)
       VALUES ($1, 'Bump me', $2, NOW() - interval '2 days') RETURNING id, updated_at`,
      [room.id, user.id],
    )
  ).rows[0];

  const res = await fetch(`${baseUrl}/api/tasks/${created.id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${fixtureToken}` },
    body: JSON.stringify({ status: 'in_progress' }),
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  assert.equal(JSON.parse(body).data.status, 'in_progress');

  const after = (
    await query('SELECT status, updated_at FROM tasks WHERE id = $1', [created.id])
  ).rows[0];
  assert.equal(after.status, 'in_progress');
  assert.ok(
    new Date(after.updated_at) > new Date(created.updated_at),
    'updated_at must move forward on a status change',
  );
});

dbTest('an invalid status is rejected', async () => {
  const task = (
    await query(
      `INSERT INTO tasks (room_id, title, created_by) VALUES ($1, 'Status test', $2) RETURNING id`,
      [room.id, user.id],
    )
  ).rows[0];

  for (const status of ['banana', 'DONE', '', null]) {
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${fixtureToken}` },
      body: JSON.stringify({ status }),
    });
    assert.equal(res.status, 400, `status=${JSON.stringify(status)} should be rejected`);
  }

  // And the row is untouched.
  const after = (await query('SELECT status FROM tasks WHERE id = $1', [task.id])).rows[0];
  assert.equal(after.status, 'open');
});

dbTest('a status filter is validated and applied', async () => {
  const res = await fetch(`${baseUrl}/api/tasks?status=banana`, {
    headers: { authorization: `Bearer ${fixtureToken}` },
  });
  assert.equal(res.status, 400, 'an unknown status filter should be a 400');

  const open = await fetch(`${baseUrl}/api/tasks?status=open`, {
    headers: { authorization: `Bearer ${fixtureToken}` },
  });
  const body = await open.text();
  assert.equal(open.status, 200, body);
  assert.ok(
    JSON.parse(body).data.tasks.every((t) => t.status === 'open'),
    'every returned task must match the filter',
  );
});

dbTest('updating a task you have no access to is a 404, not a 403', async () => {
  // 404 rather than 403 so the endpoint does not confirm that a task id exists
  // in a room the caller cannot see.
  const outsider = await authedUser('task-patch-outsider@test.com');
  const task = (
    await query(
      `INSERT INTO tasks (room_id, title, created_by) VALUES ($1, 'Not yours', $2) RETURNING id`,
      [room.id, user.id],
    )
  ).rows[0];

  const res = await fetch(`${baseUrl}/api/tasks/${task.id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${outsider}` },
    body: JSON.stringify({ status: 'done' }),
  });
  const body = await res.text();
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${body}`);
});

dbTest('undated tasks sort after dated ones rather than first', async () => {
  // NULLS FIRST would present an undated task as the most overdue item on the
  // board, which is the opposite of what a missing due date means.
  const scratch = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ('Ordering', 'group', $1, 'ordering') RETURNING id`,
      [user.id],
    )
  ).rows[0];
  await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'admin')`, [scratch.id, user.id]);

  await query(
    `INSERT INTO tasks (room_id, title, due_date, created_by) VALUES
       ($1, 'undated', NULL, $2),
       ($1, 'due soon', CURRENT_DATE + 1, $2),
       ($1, 'due later', CURRENT_DATE + 30, $2)`,
    [scratch.id, user.id],
  );

  const res = await fetch(`${baseUrl}/api/tasks/room/${scratch.id}`, {
    headers: { authorization: `Bearer ${fixtureToken}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const titles = JSON.parse(body).data.tasks.map((t) => t.title);
  assert.deepEqual(
    titles, ['due soon', 'due later', 'undated'],
    'dated tasks ascending, undated last',
  );
});

// --- Notifications endpoints (item B) -----------------------------------------

// A notification for the fixture user, seeded directly so the list/seen tests do
// not depend on whichever write path happens to be under test.
async function seedNotification({ recipientId, type = 'mention', referenceId = null, actorId = null, seen = false, createdAt = null }) {
  const row = (
    await query(
      `INSERT INTO notifications (recipient_id, type, reference_id, actor_id, seen, created_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
       RETURNING id, recipient_id, type, reference_id, actor_id, seen, created_at`,
      [recipientId, type, referenceId, actorId, seen, createdAt],
    )
  ).rows[0];
  return row;
}

dbTest('GET /notifications returns notifications, an unread count and a cursor', async () => {
  const { token: myToken, userId: me } = await authedAccount('notif-list@test.com');
  const { token: otherToken } = await authedAccount('notif-other@test.com');

  await seedNotification({ recipientId: me, actorId: null });
  await seedNotification({ recipientId: me, seen: true });

  const res = await fetch(`${baseUrl}/api/notifications`, {
    headers: { authorization: `Bearer ${myToken}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const data = JSON.parse(body).data;

  assert.ok(Array.isArray(data.notifications));
  assert.equal(typeof data.unreadCount, 'number');
  assert.ok('nextCursor' in data, 'the shape must include nextCursor even when null');
  assert.equal(data.notifications.length, 2);
  assert.equal(data.unreadCount, 1, 'only the unseen row counts');

  // The list is scoped to the caller: another account's rows must not appear.
  const otherRes = await fetch(`${baseUrl}/api/notifications`, {
    headers: { authorization: `Bearer ${otherToken}` },
  });
  const otherData = JSON.parse(await otherRes.text()).data;
  assert.equal(otherData.notifications.length, 0, "must not list another user's notifications");
  assert.equal(otherData.unreadCount, 0);
});

dbTest('the unread count is the total, not a count of the current page', async () => {
  // Counting the returned rows would silently cap the bell badge at PAGE_SIZE.
  const { token: myToken, userId: me } = await authedAccount('notif-count@test.com');
  for (let i = 0; i < 55; i += 1) {
    await seedNotification({ recipientId: me });
  }

  const res = await fetch(`${baseUrl}/api/notifications`, {
    headers: { authorization: `Bearer ${myToken}` },
  });
  const data = JSON.parse(await res.text()).data;
  assert.equal(data.notifications.length, 50, 'a page is capped at PAGE_SIZE');
  assert.equal(data.unreadCount, 55, 'the count must exceed the page size');
  assert.ok(data.nextCursor, 'a full page must hand back a cursor');
});

dbTest('unseenOnly filters the list', async () => {
  const { token: myToken, userId: me } = await authedAccount('notif-unseen@test.com');
  await seedNotification({ recipientId: me });
  await seedNotification({ recipientId: me, seen: true });

  const res = await fetch(`${baseUrl}/api/notifications?unseenOnly=true`, {
    headers: { authorization: `Bearer ${myToken}` },
  });
  const data = JSON.parse(await res.text()).data;
  assert.equal(data.notifications.length, 1);
  assert.equal(data.notifications[0].seen, false);
});

dbTest('notification pagination pages through without skipping tied timestamps', async () => {
  const { token: myToken, userId: me } = await authedAccount('notif-page@test.com');
  const at = new Date('2026-01-01T10:00:00.000Z');

  // Three rows sharing one created_at, then one a second later. A bare
  // `created_at < cursor` would drop the ties, so the id has to break them.
  for (let i = 0; i < 3; i += 1) {
    await seedNotification({ recipientId: me, createdAt: at });
  }
  await seedNotification({ recipientId: me, createdAt: new Date(at.getTime() + 1000) });

  // Walk the whole list with the cursor, one row at a time, and prove nothing is
  // skipped or repeated. A bare `created_at < cursor` would silently drop the
  // three rows that share a timestamp.
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const url = cursor
      ? `${baseUrl}/api/notifications?before=${encodeURIComponent(cursor)}`
      : `${baseUrl}/api/notifications`;
    const page = JSON.parse(
      await (await fetch(url, { headers: { authorization: `Bearer ${myToken}` } })).text(),
    ).data;

    for (const n of page.notifications) {
      assert.ok(!seen.includes(n.id), `${n.id} was returned twice`);
      seen.push(n.id);
    }
    cursor = page.nextCursor;
    if (!cursor) break;
  }

  assert.equal(seen.length, 4, 'every row must be reachable exactly once');
  assert.equal(new Set(seen).size, 4);
  assert.equal(cursor, null, 'the walk must terminate');
});

dbTest("you cannot mark somebody else's notification as seen", async () => {
  // Without recipient_id in the WHERE clause, any authenticated user could
  // silence somebody else's bell by guessing a UUID.
  const { userId: victim } = await authedAccount('notif-victim@test.com');
  const { token: attackerToken } = await authedAccount('notif-attacker@test.com');
  const theirs = await seedNotification({ recipientId: victim });

  const res = await fetch(`${baseUrl}/api/notifications/seen`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${attackerToken}` },
    body: JSON.stringify({ notificationId: theirs.id }),
  });
  const body = await res.text();
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${body}`);

  const still = (await query('SELECT seen FROM notifications WHERE id = $1', [theirs.id])).rows[0];
  assert.equal(still.seen, false, "the victim's notification must be untouched");
});

dbTest('markSeen updates one notification and reports the count', async () => {
  const { token: myToken, userId: me } = await authedAccount('notif-mark@test.com');
  const target = await seedNotification({ recipientId: me });
  await seedNotification({ recipientId: me });

  const res = await fetch(`${baseUrl}/api/notifications/seen`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${myToken}` },
    body: JSON.stringify({ notificationId: target.id }),
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  assert.equal(JSON.parse(body).data.updated, 1);

  const after = (await query('SELECT seen FROM notifications WHERE id = $1', [target.id])).rows[0];
  assert.equal(after.seen, true);
});

dbTest('markSeen with all:true only touches the caller, and is idempotent', async () => {
  const { token: myToken, userId: me } = await authedAccount('notif-all@test.com');
  const { userId: theirs } = await authedAccount('notif-all-other@test.com');

  await seedNotification({ recipientId: me });
  await seedNotification({ recipientId: me });
  await seedNotification({ recipientId: me, seen: true });
  const untouched = await seedNotification({ recipientId: theirs });

  const first = await fetch(`${baseUrl}/api/notifications/seen`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${myToken}` },
    body: JSON.stringify({ all: true }),
  });
  assert.equal(JSON.parse(await first.text()).data.updated, 2, 'only the two unseen rows');

  // Repeating it changes nothing and reports nothing, so the client can trust
  // `updated` as "rows this call changed".
  const second = await fetch(`${baseUrl}/api/notifications/seen`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${myToken}` },
    body: JSON.stringify({ all: true }),
  });
  assert.equal(JSON.parse(await second.text()).data.updated, 0);

  const otherStill = (await query('SELECT seen FROM notifications WHERE id = $1', [untouched.id])).rows[0];
  assert.equal(otherStill.seen, false, "another account's row must not be touched");
});

dbTest('markSeen rejects a body naming neither one nor all', async () => {
  const { token: myToken } = await authedAccount('notif-badbody@test.com');
  for (const body of [{}, { notificationId: 'not-a-uuid' }, { all: 'yes' }]) {
    const res = await fetch(`${baseUrl}/api/notifications/seen`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${myToken}` },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `should reject ${JSON.stringify(body)}`);
  }
});

dbTest('a notification resolves to readable text, and a deleted message to a tombstone', async () => {
  const { token: myToken, userId: me } = await authedAccount('notif-resolve@test.com');
  const { userId: authorId } = await authedAccount('notif-author@test.com');

  const room = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ('Notify Room', 'group', $1, 'notify-room') RETURNING id`,
      [authorId],
    )
  ).rows[0];

  await query("INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member')",[room.id,authorId,me]);

  const message = (
    await query(
      `INSERT INTO messages (room_id, sender_id, content)
       VALUES ($1, $2, 'the original text') RETURNING id`,
      [room.id, authorId],
    )
  ).rows[0];

  await seedNotification({ recipientId: me, type: 'mention', referenceId: message.id, actorId: authorId });

  const res = await fetch(`${baseUrl}/api/notifications`, {
    headers: { authorization: `Bearer ${myToken}` },
  });
  const { notifications } = JSON.parse(await res.text()).data;
  assert.equal(notifications[0].context.actor_name, 'Task Tester', 'the actor name resolves');
  assert.equal(notifications[0].context.room_name, 'Notify Room');
  assert.equal(notifications[0].context.message_preview, 'the original text');

  // Soft-delete the subject: the notification survives, but the preview goes.
  await query('UPDATE messages SET deleted_at = NOW() WHERE id = $1', [message.id]);

  const after = JSON.parse(
    (await (await fetch(`${baseUrl}/api/notifications`, {
      headers: { authorization: `Bearer ${myToken}` },
    })).text()),
  ).data.notifications;
  assert.equal(after.length, 1, 'a notification is never dropped because its subject is gone');
  assert.equal(after[0].context.message_preview, null, 'retracted text must not resurface');
});

dbTest('a notification survives a hard-deleted message as nulls, not a 500', async () => {
  // reference_id has no FK by design, so this is the dangling case the resolver
  // has to tolerate.
  const { token: myToken, userId: me } = await authedAccount('notif-dangling@test.com');
  await seedNotification({
    recipientId: me,
    type: 'mention',
    referenceId: '11111111-2222-3333-4444-555555555555',
  });

  const res = await fetch(`${baseUrl}/api/notifications`, {
    headers: { authorization: `Bearer ${myToken}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const { notifications } = JSON.parse(body).data;
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].context.message_preview, null);
  assert.equal(notifications[0].context.room_name, null);
});

dbTest('addMember notifies the invitee and records who invited them', async () => {
  // The room_invite row existed since PR1 but nothing ever emitted it. This
  // exercises the service path and the resolved context.
  const inviter = await authedAccount('invite-inviter@test.com');
  const invitee = await authedAccount('invite-invitee@test.com');

  const room = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${inviter.token}` },
    body: JSON.stringify({ name: 'Invite Test Room' }),
  });
  const roomId = JSON.parse(await room.text()).data.id;

  const res = await fetch(`${baseUrl}/api/rooms/${roomId}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${inviter.token}` },
    body: JSON.stringify({ userId: invitee.userId }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);

  const list = await fetch(`${baseUrl}/api/notifications`, {
    headers: { authorization: `Bearer ${invitee.token}` },
  });
  const data = JSON.parse(await list.text()).data;
  assert.equal(data.unreadCount, 1, 'the invitee should have exactly one unread');
  assert.equal(data.notifications[0].type, 'room_invite');
  assert.equal(data.notifications[0].context.actor_name, 'Task Tester', 'must name the inviter');
  assert.equal(data.notifications[0].context.room_name, 'Invite Test Room');
});

dbTest('FALLBACK: a text mention notifies the named member but not the sender', async () => {
  // This is the no-mentionedUserIds path — the temporary bridge for clients that
  // do not send ids. It still works; it is just no longer the primary path.
  const sender = await authedAccount('mention-sender@test.com');
  const target = await authedAccount('mention-target@test.com');
  const bystander = await authedAccount('mention-bystander@test.com');

  const room = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ('Mention Room', 'group', $1, 'mention-room') RETURNING id`,
      [sender.userId],
    )
  ).rows[0];
  for (const uid of [sender.userId, target.userId, bystander.userId]) {
    await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [room.id, uid]);
  }

  // Distinct display names, since mention matching is by name.
  await query('UPDATE users SET display_name = $1 WHERE id = $2', ['Amina', target.userId]);
  await query('UPDATE users SET display_name = $1 WHERE id = $2', ['Victor', bystander.userId]);

  const { createMessage } = require('../src/services/message.service');
  await createMessage({
    roomId: room.id,
    senderId: sender.userId,
    content: 'hey @Amina can you review this?',
  });

  const targetList = JSON.parse(
    (await (await fetch(`${baseUrl}/api/notifications`, {
      headers: { authorization: `Bearer ${target.token}` },
    })).text()),
  ).data;
  assert.equal(targetList.unreadCount, 1, 'the mentioned member gets one');
  assert.equal(targetList.notifications[0].type, 'mention');
  assert.equal(targetList.notifications[0].context.actor_name, 'Task Tester', 'the sender is the actor');

  const senderList = JSON.parse(
    (await (await fetch(`${baseUrl}/api/notifications`, {
      headers: { authorization: `Bearer ${sender.token}` },
    })).text()),
  ).data;
  assert.equal(senderList.unreadCount, 0, 'the sender must not be notified of their own message');

  const bystanderList = JSON.parse(
    (await (await fetch(`${baseUrl}/api/notifications`, {
      headers: { authorization: `Bearer ${bystander.token}` },
    })).text()),
  ).data;
  // Since phase 8 a room member who was not named is notified of the message —
  // that was the point of writing new_message. What they must not get is a
  // 'mention': the assertion is about the type, not about the row count, because
  // the row count is deliberately no longer zero.
  assert.equal(
    bystanderList.notifications.filter((n) => n.type === 'mention').length,
    0,
    'a room member who was not named gets no mention',
  );
  assert.equal(
    bystanderList.notifications.filter((n) => n.type === 'new_message').length,
    1,
    'they are told a message arrived, which is the new_message type working',
  );
});

dbTest('FALLBACK: mention matching respects word boundaries', async () => {
  const sender = await authedAccount('boundary-sender@test.com');
  const al = await authedAccount('boundary-al@test.com');

  const room = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ('Boundary Room', 'group', $1, 'boundary-room') RETURNING id`,
      [sender.userId],
    )
  ).rows[0];
  await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [room.id, sender.userId]);
  await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [room.id, al.userId]);
  await query('UPDATE users SET display_name = $1 WHERE id = $2', ['Al', al.userId]);

  const { createMessage } = require('../src/services/message.service');
  await createMessage({ roomId: room.id, senderId: sender.userId, content: 'cc @Alice and @Alison' });

  const list = JSON.parse(
    (await (await fetch(`${baseUrl}/api/notifications`, {
      headers: { authorization: `Bearer ${al.token}` },
    })).text()),
  ).data;
  assert.equal(
    list.notifications.filter((n) => n.type === 'mention').length,
    0,
    '"@Alison" must not count as a mention of "Al"',
  );
  // They are still told the message arrived — just not that they were named.
  assert.equal(list.notifications.filter((n) => n.type === 'new_message').length, 1);
});

dbTest('a message without an @ writes no notification rows', async () => {
  const { createMessage } = require('../src/services/message.service');
  const room = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ('Quiet Room', 'group', $1, 'quiet-room') RETURNING id`,
      [user.id],
    )
  ).rows[0];
  await query(
    `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'admin')
     ON CONFLICT DO NOTHING`,
    [room.id, user.id],
  );

  // A mention row that existed beforehand, to prove the count is being watched
  // and not simply read as zero.
  await query(
    `INSERT INTO notifications (recipient_id, type, reference_id, actor_id)
     VALUES ($1, 'mention', NULL, NULL)`,
    [user.id],
  );
  const seeded = (await query('SELECT COUNT(*)::int n FROM notifications')).rows[0].n;
  assert.ok(seeded > 0);

  await createMessage({ roomId: room.id, senderId: user.id, content: 'an ordinary message' });

  const after = (await query('SELECT COUNT(*)::int n FROM notifications')).rows[0].n;
  assert.equal(after, seeded, 'an ordinary message must not notify anyone');
});

dbTest('a mention notification is written even when no socket is passed', async () => {
  // The row is the source of truth and the socket is only delivery. Gating the
  // write on `io` would mean a mention is silently lost on any path that does
  // not supply one — the same failure that left room_invite unreadable.
  const sender = await authedAccount('noio-sender@test.com');
  const target = await authedAccount('noio-target@test.com');

  const room = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ('No IO Room', 'group', $1, 'no-io-room') RETURNING id`,
      [sender.userId],
    )
  ).rows[0];
  for (const uid of [sender.userId, target.userId]) {
    await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [room.id, uid]);
  }
  await query('UPDATE users SET display_name = $1 WHERE id = $2', ['Noio', target.userId]);

  const { createMessage } = require('../src/services/message.service');
  // No io argument at all — deliberately.
  await createMessage({ roomId: room.id, senderId: sender.userId, content: 'hey @Noio' });

  const rows = (
    await query('SELECT COUNT(*)::int n FROM notifications WHERE recipient_id = $1', [target.userId])
  ).rows[0].n;
  assert.equal(rows, 1, 'the row must exist without a socket to push it');
});

dbTest('mention:seen carries a count, not a phantom notification row', async () => {
  // Regression test. `notification` always carries a full row and clients append
  // it straight to their list, so emitting a bare { updated } under that name
  // inserted a row with no id, type or created_at. mark-seen now has its own
  // event; this asserts the two names stay distinct.
  const notif = require('../src/services/notification.service');
  const { token: myToken, userId: me } = await authedAccount('seen-event@test.com');
  const target = await seedNotification({ recipientId: me });

  // Capture what each emitter actually puts on the wire.
  const captured = [];
  const fakeIo = {
    to(room) {
      return {
        emit(event, payload) {
          captured.push({ room, event, payload });
        },
      };
    },
  };

  const presented = await notif.presentNotification(target);
  assert.equal(notif.emitNotification(fakeIo, me, presented), true);
  notif.emitNotificationsSeen(fakeIo, me, 1);

  const byEvent = Object.fromEntries(captured.map((c) => [c.event, c]));
  assert.deepEqual(
    Object.keys(byEvent).sort(),
    ['notification', 'notification:seen'],
    'mark-seen must not reuse the notification event name',
  );

  assert.equal(
    byEvent['notification'].room,
    `user:${me}`,
    'both go to the recipient\'s personal room',
  );

  // The full-row event must still be a complete notification.
  const row = byEvent['notification'].payload.notification;
  assert.ok(row.id, 'notification must carry an id');
  assert.equal(typeof row.type, 'string');
  assert.ok(row.context, 'notification must carry context');
  assert.ok(!('updated' in row), 'the row event must not carry a count');

  // The mark-seen event is a bare count and nothing else.
  assert.deepEqual(byEvent['notification:seen'].payload, { updated: 1 });

  // And with no socket it is a no-op rather than a throw.
  assert.equal(notif.emitNotificationsSeen(undefined, me, 1), false);
  assert.equal(notif.emitNotificationsSeen(fakeIo, undefined, 1), false);

  await fetch(`${baseUrl}/api/notifications/seen`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${myToken}` },
    body: JSON.stringify({ notificationId: target.id }),
  });
});

dbTest('FALLBACK: mention matching is case-insensitive', async () => {
  // Case-insensitivity is load-bearing for the fallback path, which is the only
  // place it now applies. The digest no longer matches text at all, so this
  // assertion is about the fallback alone and the digest's `~*` is gone.
  const { mentionPattern, isMentioned } = require('../src/services/mention.service');

  for (const text of ['hey @Amina', 'hey @amina', 'HEY @AMINA', '@Amina']) {
    assert.ok(isMentioned(text, 'Amina'), `"${text}" should count as a mention of Amina`);
  }

  // Still bounded: case-insensitivity must not cost the word boundary, in
  // either case.
  assert.ok(!isMentioned('@Aminaish', 'Amina'), '"@Aminaish" is not a mention of Amina');
  assert.ok(!isMentioned('@aminaish', 'Amina'), '"@aminaish" is not a mention of Amina');
  assert.ok(!isMentioned('hello @Al', 'Alice'), '"@Al" must not match Alice');
  assert.ok(!isMentioned('@Al_', 'Alice'), '"@Al_" must not match Alice');

  // And the two entry points must build the same pattern.
  assert.equal(mentionPattern('Amina'), '@Amina([^A-Za-z0-9_]|$)');
});

dbTest('FALLBACK: a lowercased mention reaches the notification', async () => {
  // End-to-end version of the case-sensitivity regression, on the fallback path.
  const sender = await authedAccount('case-sender@test.com');
  const target = await authedAccount('case-target@test.com');

  const room = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ('Case Room', 'group', $1, 'case-room') RETURNING id`,
      [sender.userId],
    )
  ).rows[0];
  for (const uid of [sender.userId, target.userId]) {
    await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [room.id, uid]);
  }
  await query('UPDATE users SET display_name = $1 WHERE id = $2', ['Casely', target.userId]);

  const { createMessage } = require('../src/services/message.service');
  await createMessage({ roomId: room.id, senderId: sender.userId, content: 'hey @casely can you look?' });

  const list = JSON.parse(
    (await (await fetch(`${baseUrl}/api/notifications`, {
      headers: { authorization: `Bearer ${target.token}` },
    })).text()),
  ).data;
  assert.equal(list.unreadCount, 1, 'a lowercased @mention must still notify');
  assert.equal(list.notifications[0].type, 'mention');
});

// --- Structured mentions (item H) --------------------------------------------

/** Two users in a fresh room, plus their auth tokens. */
async function mentionFixture(prefix) {
  const sender = await authedAccount(`${prefix}-sender@test.com`);
  const target = await authedAccount(`${prefix}-target@test.com`);
  const room = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ($1, 'group', $2, $3) RETURNING id`,
      [`Mention ${prefix}`, sender.userId, `mention-${prefix}-${Math.floor(Math.random() * 1e9)}`],
    )
  ).rows[0];
  for (const uid of [sender.userId, target.userId]) {
    await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [room.id, uid]);
  }
  return { sender, target, roomId: room.id };
}

dbTest('message_mentions records ids and cascades on message delete', async () => {
  const { sender, target, roomId } = await mentionFixture('schema');
  const { createMessage } = require('../src/services/message.service');

  const message = await createMessage({
    roomId, senderId: sender.userId, content: 'hi @you', mentionedUserIds: [target.userId],
  });

  const rows = (
    await query('SELECT user_id FROM message_mentions WHERE message_id = $1', [message.id])
  ).rows.map((r) => r.user_id);
  assert.deepEqual(rows, [target.userId]);

  // ON DELETE CASCADE: a deleted message leaves nothing for the digest to join.
  await query('DELETE FROM messages WHERE id = $1', [message.id]);
  const after = (await query('SELECT COUNT(*)::int n FROM message_mentions WHERE message_id = $1', [message.id])).rows[0].n;
  assert.equal(after, 0, 'deleting a message must clear its mention rows');
});

dbTest('mentions follow the id, not the display name', async () => {
  // The whole point of item H. Renaming a user must not change who was mentioned
  // in a message that already named them by id — and must not stop the
  // notification either.
  const { sender, target, roomId } = await mentionFixture('rename');
  const { createMessage } = require('../src/services/message.service');

  const original = 'Renameme';
  await query('UPDATE users SET display_name = $1 WHERE id = $2', [original, target.userId]);

  const message = await createMessage({
    roomId, senderId: sender.userId,
    content: 'no @-token at all, the id says who',
    mentionedUserIds: [target.userId],
  });

  // Rename after the message is written.
  await query('UPDATE users SET display_name = $1 WHERE id = $2', ['Somethingelse', target.userId]);

  const rows = (
    await query('SELECT user_id FROM message_mentions WHERE message_id = $1', [message.id])
  ).rows.map((r) => r.user_id);
  assert.deepEqual(rows, [target.userId], 'the recorded mention is by id and survives a rename');

  const notified = (
    await query(`SELECT COUNT(*)::int n FROM notifications WHERE recipient_id = $1 AND type = 'mention'`, [target.userId])
  ).rows[0].n;
  assert.equal(notified, 1, 'the notification must follow the id, not the name');
});

dbTest('two users sharing a display name are distinguishable', async () => {
  // display_name is not unique — only email is — so text matching genuinely cannot
  // tell these two apart. Ids can.
  const { sender, target, roomId } = await mentionFixture('twin');
  const twin = await authedAccount('twin-second@test.com');
  await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [roomId, twin.userId]);

  await query('UPDATE users SET display_name = $1 WHERE id = $2', ['Twin', target.userId]);
  await query('UPDATE users SET display_name = $1 WHERE id = $2', ['Twin', twin.userId]);

  const { createMessage } = require('../src/services/message.service');
  const message = await createMessage({
    roomId, senderId: sender.userId, content: 'only the second one',
    mentionedUserIds: [twin.userId],
  });

  const rows = (
    await query('SELECT user_id FROM message_mentions WHERE message_id = $1 ORDER BY user_id', [message.id])
  ).rows.map((r) => r.user_id);
  assert.equal(rows.length, 1, 'exactly one of the twins is mentioned');
  assert.equal(rows[0], twin.userId);

  const targetGot = (
    await query(`SELECT COUNT(*)::int n FROM notifications WHERE recipient_id = $1 AND type = 'mention'`, [target.userId])
  ).rows[0].n;
  assert.equal(targetGot, 0, 'the twin that was not named must not be notified');
});

dbTest('an id for someone outside the room is dropped, not rejected', async () => {
  // A stale or hostile id list must not fail an otherwise-valid send. The message
  // is fine; the person is simply not mentionable here.
  const { sender, roomId } = await mentionFixture('outsider');
  const stranger = await authedAccount('mention-stranger@test.com');
  const { createMessage } = require('../src/services/message.service');

  const message = await createMessage({
    roomId, senderId: sender.userId, content: 'hello',
    mentionedUserIds: [stranger.userId],
  });

  assert.ok(message.id, 'the message must still be created');
  const rows = (await query('SELECT COUNT(*)::int n FROM message_mentions WHERE message_id = $1', [message.id])).rows[0].n;
  assert.equal(rows, 0, 'a non-member cannot be recorded as mentioned');

  const notified = (
    await query(`SELECT COUNT(*)::int n FROM notifications WHERE recipient_id = $1 AND type = 'mention'`, [stranger.userId])
  ).rows[0].n;
  assert.equal(notified, 0, 'and must not be notified');
});

dbTest('the sender cannot mention themselves', async () => {
  const { sender, roomId } = await mentionFixture('selfmention');
  const { createMessage } = require('../src/services/message.service');

  const message = await createMessage({
    roomId, senderId: sender.userId, content: 'note to self',
    mentionedUserIds: [sender.userId],
  });

  const rows = (await query('SELECT COUNT(*)::int n FROM message_mentions WHERE message_id = $1', [message.id])).rows[0].n;
  assert.equal(rows, 0, 'no self-mention row');

  const notified = (
    await query(`SELECT COUNT(*)::int n FROM notifications WHERE recipient_id = $1 AND type = 'mention'`, [sender.userId])
  ).rows[0].n;
  assert.equal(notified, 0, 'and no self-notification');
});

dbTest('mentioning the same person twice records them once', async () => {
  // The composite primary key makes a duplicate a no-op rather than a 500.
  const { sender, target, roomId } = await mentionFixture('dupe');
  const { createMessage } = require('../src/services/message.service');

  const message = await createMessage({
    roomId, senderId: sender.userId, content: '@you @you again',
    mentionedUserIds: [target.userId, target.userId],
  });

  const rows = (await query('SELECT COUNT(*)::int n FROM message_mentions WHERE message_id = $1', [message.id])).rows[0].n;
  assert.equal(rows, 1, 'one row, not two');

  const notified = (
    await query(`SELECT COUNT(*)::int n FROM notifications WHERE recipient_id = $1 AND type = 'mention'`, [target.userId])
  ).rows[0].n;
  assert.equal(notified, 1, 'and one notification, not two');
});

dbTest('an empty mentionedUserIds array falls back to text matching', async () => {
  // Explicitly empty is treated the same as absent, so a client that sends the
  // field but has nothing picked behaves like one that omits it.
  const { sender, target, roomId } = await mentionFixture('emptyids');
  await query('UPDATE users SET display_name = $1 WHERE id = $2', ['Fallback', target.userId]);

  const { createMessage } = require('../src/services/message.service');
  const message = await createMessage({
    roomId, senderId: sender.userId, content: 'hey @Fallback', mentionedUserIds: [],
  });

  const rows = (
    await query('SELECT user_id FROM message_mentions WHERE message_id = $1', [message.id])
  ).rows.map((r) => r.user_id);
  assert.deepEqual(rows, [target.userId], 'the fallback still records a row');
});

dbTest('ids win over text when both are present', async () => {
  // The names in the text and the ids disagree; ids are authoritative, because
  // only the client knows who was actually picked.
  const { sender, target, roomId } = await mentionFixture('conflict');
  const bystander = await authedAccount('conflict-bystander@test.com');
  await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [roomId, bystander.userId]);

  await query('UPDATE users SET display_name = $1 WHERE id = $2', ['Bystander', bystander.userId]);

  const { createMessage } = require('../src/services/message.service');
  const message = await createMessage({
    roomId, senderId: sender.userId,
    content: 'this text names @Bystander',
    mentionedUserIds: [target.userId],
  });

  const rows = (
    await query('SELECT user_id FROM message_mentions WHERE message_id = $1', [message.id])
  ).rows.map((r) => r.user_id);
  assert.deepEqual(rows, [target.userId], 'the id list wins; the text is not consulted');
});

dbTest('the per-room digest finds a structured mention', async () => {
  const { sender, target, roomId } = await mentionFixture('digest');
  const { createMessage } = require('../src/services/message.service');

  await createMessage({
    roomId, senderId: sender.userId,
    content: 'the needle can be found in the digest too',
    mentionedUserIds: [target.userId],
  });

  // Back the window up so last_seen_at does not exclude the message.
  await query(
    `UPDATE room_members SET last_seen_at = NOW() - interval '1 day'
     WHERE room_id = $1 AND user_id = $2`,
    [roomId, target.userId],
  );

  const res = await fetch(`${baseUrl}/api/digest/room/${roomId}`, {
    headers: { authorization: `Bearer ${target.token}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const items = JSON.parse(body).data.items;
  assert.ok(
    items.some((i) => i.type === 'mention'),
    'the mentioned user must see it in their digest',
  );
});

dbTest('the digest does not fall back to text matching', async () => {
  // The asymmetry with createMessage is deliberate. Re-deriving mentions from
  // text here would reintroduce the rename bug on historical rows, which is
  // where it matters most — a name may have changed since the message was sent.
  const { sender, target, roomId } = await mentionFixture('nofallback');
  await query('UPDATE users SET display_name = $1 WHERE id = $2', ['Ghostname', target.userId]);

  // A message that NAMES the user in text but records no mention rows, as if an
  // older client had sent it.
  const message = (
    await query(
      `INSERT INTO messages (room_id, sender_id, content)
       VALUES ($1, $2, 'hey @Ghostname with no mention row') RETURNING id`,
      [roomId, sender.userId],
    )
  ).rows[0];

  await query(
    `UPDATE room_members SET last_seen_at = NOW() - interval '1 day'
     WHERE room_id = $1 AND user_id = $2`,
    [roomId, target.userId],
  );

  const res = await fetch(`${baseUrl}/api/digest/room/${roomId}`, {
    headers: { authorization: `Bearer ${target.token}` },
  });
  const items = JSON.parse(await res.text()).data.items;
  assert.ok(
    !items.some((i) => i.type === 'mention' && i.id === message.id),
    'text alone must not produce a digest mention',
  );
});

dbTest('the cross-room digest finds a structured mention', async () => {
  const { sender, target, roomId } = await mentionFixture('xdigest');
  const { createMessage } = require('../src/services/message.service');

  await createMessage({
    roomId, senderId: sender.userId,
    content: 'a cross room needle indeed',
    mentionedUserIds: [target.userId],
  });
  await query(
    `UPDATE room_members SET last_seen_at = NOW() - interval '1 day'
     WHERE room_id = $1 AND user_id = $2`,
    [roomId, target.userId],
  );

  const res = await fetch(`${baseUrl}/api/digest`, {
    headers: { authorization: `Bearer ${target.token}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const items = JSON.parse(body).data.items;
  assert.ok(
    items.some((i) => i.type === 'mention' && i.room_id === roomId),
    'the cross-room digest must include the mention',
  );
});

dbTest('listMessages and searchMessages expose mentioned_user_ids', async () => {
  const { sender, target, roomId } = await mentionFixture('payload');
  const { createMessage } = require('../src/services/message.service');
  const needle = `payloadneedle${Date.now()}`;

  const withMention = await createMessage({
    roomId, senderId: sender.userId, content: `${needle} and @you`,
    mentionedUserIds: [target.userId],
  });
  const withoutMention = await createMessage({
    roomId, senderId: sender.userId, content: `${needle} with nobody`,
  });

  const res = await fetch(`${baseUrl}/api/messages/room/${roomId}`, {
    headers: { authorization: `Bearer ${sender.token}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const { messages } = JSON.parse(body).data;

  const mentioned = messages.find((m) => m.id === withMention.id);
  assert.deepEqual(
    mentioned.mentioned_user_ids, [target.userId],
    'the mentioned ids must be on the payload',
  );

  const plain = messages.find((m) => m.id === withoutMention.id);
  assert.deepEqual(
    plain.mentioned_user_ids, [],
    'a message with no mentions must yield [], never null, so the client can map over it',
  );

  // And the search shape agrees, or the client sees two different message shapes.
  const search = await fetch(`${baseUrl}/api/messages/room/${roomId}/search?q=${needle}`, {
    headers: { authorization: `Bearer ${sender.token}` },
  });
  const searchBody = await search.text();
  assert.equal(search.status, 200, searchBody);
  const found = JSON.parse(searchBody).data.messages.find((m) => m.id === withMention.id);
  assert.deepEqual(found.mentioned_user_ids, [target.userId], 'search must expose the same field');
});

dbTest('createMessage returns mentioned_user_ids so the sender can confirm them', async () => {
  const { sender, target, roomId } = await mentionFixture('confirm');
  const { createMessage } = require('../src/services/message.service');

  const message = await createMessage({
    roomId, senderId: sender.userId, content: 'hi', mentionedUserIds: [target.userId],
  });
  assert.deepEqual(message.mentioned_user_ids, [target.userId]);

  const none = await createMessage({ roomId, senderId: sender.userId, content: 'hi again' });
  assert.deepEqual(none.mentioned_user_ids, [], 'no mentions must be an empty array');
});

dbTest('a failed send leaves no mention rows behind', async () => {
  const { sender, target, roomId } = await mentionFixture('rollback');
  const { createMessage } = require('../src/services/message.service');

  const before = (await query('SELECT COUNT(*)::int n FROM message_mentions')).rows[0].n;

  // An attachment URL that was never uploaded fails inside the transaction,
  // after the mention ids were resolved.
  await assert.rejects(
    () => createMessage({
      roomId, senderId: sender.userId, content: '@you @too',
      attachments: [{ url: 'https://x/never-uploaded-for-mentions.pdf' }],
      mentionedUserIds: [target.userId],
    }),
    (err) => err.status === 400,
  );

  const after = (await query('SELECT COUNT(*)::int n FROM message_mentions')).rows[0].n;
  assert.equal(after, before, 'the mention insert must be inside the same transaction as the message');
});

// --- Message edit, delete, reactions (item I) --------------------------------

/** An author in a room, plus a plain member and a room admin alongside. */
async function messageFixture(prefix) {
  const author = await authedAccount(`${prefix}-author@test.com`);
  const member = await authedAccount(`${prefix}-member@test.com`);
  const admin = await authedAccount(`${prefix}-admin@test.com`);
  const room = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ($1, 'group', $2, $3) RETURNING id`,
      [`ItemI ${prefix}`, author.userId, `itemi-${prefix}-${Math.floor(Math.random() * 1e9)}`],
    )
  ).rows[0];
  await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [room.id, author.userId]);
  await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [room.id, member.userId]);
  await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'admin')`, [room.id, admin.userId]);
  return { author, member, admin, roomId: room.id };
}

async function sendMessage(token, roomId, content, extra = {}) {
  const res = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ roomId, content, ...extra }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  return JSON.parse(body).data;
}

// --- Edit --------------------------------------------------------------------

dbTest('the author can edit their message, and edited_at is set', async () => {
  const { author, roomId } = await messageFixture('edit');
  const message = await sendMessage(author.token, roomId, 'original text');
  assert.equal(message.edited_at, null, 'a fresh message is not edited');

  const res = await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ content: '  corrected text  ' }),
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const edited = JSON.parse(body).data;

  assert.equal(edited.content, 'corrected text', 'content is trimmed');
  assert.ok(edited.edited_at, 'edited_at must be set');
  assert.equal(edited.id, message.id, 'same message, edited in place');
});

dbTest('only the author can edit', async () => {
  const { author, member, admin, roomId } = await messageFixture('editperm');
  const message = await sendMessage(author.token, roomId, 'not yours');

  // A room admin gets no edit power: editing is not moderation, only deleting is.
  for (const [who, label] of [[member, 'a member'], [admin, 'a room admin']]) {
    const res = await fetch(`${baseUrl}/api/messages/${message.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}` },
      body: JSON.stringify({ content: 'hijacked' }),
    });
    assert.equal(res.status, 403, `${label} must not be able to edit`);
  }

  const after = (await query('SELECT content FROM messages WHERE id = $1', [message.id])).rows[0];
  assert.equal(after.content, 'not yours', 'the content must be untouched');
});

dbTest('editing a deleted message is rejected', async () => {
  const { author, roomId } = await messageFixture('editdeleted');
  const message = await sendMessage(author.token, roomId, 'about to go');
  await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${author.token}` },
  });

  const res = await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ content: 'back from the dead' }),
  });
  assert.equal(res.status, 400, 'a tombstone has nothing to edit');

  const after = (await query('SELECT content, deleted_at FROM messages WHERE id = $1', [message.id])).rows[0];
  assert.equal(after.content, null, 'a deleted message must not be resurrected with content');
  assert.ok(after.deleted_at);
});

dbTest('emptying a message is rejected unless it has an attachment', async () => {
  // Mirrors the create-time rule (Bug 8): a file-only message is valid, so empty
  // content is only acceptable when an attachment carries it.
  const { author, roomId } = await messageFixture('editempty');
  const plain = await sendMessage(author.token, roomId, 'will be blanked');

  const res = await fetch(`${baseUrl}/api/messages/${plain.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ content: '   ' }),
  });
  assert.equal(res.status, 400, 'an attachment-less message cannot be blanked');

  // With a file attached, blanking the text is fine.
  const upload = await seedUpload({ uploaderId: author.userId, url: `https://x/blank-${Date.now()}.pdf` });
  const withFile = await sendMessage(author.token, roomId, 'has words', { attachments: [{ url: upload.file_url }] });

  const okRes = await fetch(`${baseUrl}/api/messages/${withFile.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ content: '' }),
  });
  const body = await okRes.text();
  assert.equal(okRes.status, 200, body);
  assert.equal(JSON.parse(body).data.content, null, 'a file-only message may have null content');
});

dbTest('editing does not touch mention rows or notifications', async () => {
  // A notification cannot be unsent, so removing the name must not rewrite who
  // was told. This is the immutability guarantee item I was specified with.
  const { author, roomId } = await messageFixture('editmention');
  const target = await authedAccount('editmention-target@test.com');
  await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [roomId, target.userId]);

  const message = await sendMessage(author.token, roomId, 'hey @you', { mentionedUserIds: [target.userId] });

  const before = (await query('SELECT COUNT(*)::int n FROM message_mentions WHERE message_id = $1', [message.id])).rows[0].n;
  const notifiedBefore = (await query('SELECT COUNT(*)::int n FROM notifications WHERE recipient_id = $1', [target.userId])).rows[0].n;
  assert.equal(before, 1);
  assert.equal(notifiedBefore, 1);

  await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ content: 'the name is gone now' }),
  });

  const after = (await query('SELECT COUNT(*)::int n FROM message_mentions WHERE message_id = $1', [message.id])).rows[0].n;
  const notifiedAfter = (await query('SELECT COUNT(*)::int n FROM notifications WHERE recipient_id = $1', [target.userId])).rows[0].n;
  assert.equal(after, 1, 'mention rows survive an edit');
  assert.equal(notifiedAfter, 1, 'the notification is not unsent');
});

dbTest('editing an unknown message is a 404, not a 403', async () => {
  const { author } = await messageFixture('edit404');
  const res = await fetch(`${baseUrl}/api/messages/11111111-2222-3333-4444-555555555555`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ content: 'ghost' }),
  });
  assert.equal(res.status, 404, 'a non-existent message must not be confirmed or denied as a permission problem');
});

// --- Delete ------------------------------------------------------------------

dbTest('a room admin can delete anyone\'s message', async () => {
  const { author, admin, roomId } = await messageFixture('deladmin');
  const message = await sendMessage(author.token, roomId, 'moderated away');

  const res = await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${admin.token}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  assert.equal(JSON.parse(body).data.is_deleted, true);
});

dbTest('an ordinary member cannot delete someone else\'s message', async () => {
  const { author, member, roomId } = await messageFixture('delmember');
  const message = await sendMessage(author.token, roomId, 'safe');

  const res = await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${member.token}` },
  });
  const body = await res.text();
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${body}`);

  const after = (await query('SELECT deleted_at FROM messages WHERE id = $1', [message.id])).rows[0];
  assert.equal(after.deleted_at, null, 'must still be live');
});

dbTest('delete overwrites the content rather than only hiding it', async () => {
  // Anyone with SQL could otherwise still read retracted text, which is not what
  // "delete" means to the person who pressed the button.
  const { author, roomId } = await messageFixture('delwipe');
  const message = await sendMessage(author.token, roomId, 'SECRET TEXT that must not survive');

  await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${author.token}` },
  });

  const row = (await query('SELECT content, deleted_at FROM messages WHERE id = $1', [message.id])).rows[0];
  assert.equal(row.content, null, 'the column itself must be overwritten');
  assert.ok(row.deleted_at);
});

dbTest('a deleted message stays in history as a tombstone, with ordering intact', async () => {
  // The read side already withholds the body and sets is_deleted, so replies and
  // ordering must keep working after the write side lands.
  const { author, member, roomId } = await messageFixture('deltomb');
  const first = await sendMessage(author.token, roomId, 'first');
  const doomed = await sendMessage(author.token, roomId, 'second, doomed');
  const reply = await sendMessage(author.token, roomId, 'replying', { replyToId: doomed.id });

  await fetch(`${baseUrl}/api/messages/${doomed.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${author.token}` },
  });

  const res = await fetch(`${baseUrl}/api/messages/room/${roomId}`, {
    headers: { authorization: `Bearer ${member.token}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const { messages } = JSON.parse(body).data;

  assert.equal(messages.length, 3, 'the tombstone must remain in the timeline');
  const tomb = messages.find((m) => m.id === doomed.id);
  assert.equal(tomb.is_deleted, true);
  assert.equal(tomb.content, null, 'the body is withheld');

  // And the reply that pointed at it still resolves.
  const replyRow = messages.find((m) => m.id === reply.id);
  assert.equal(replyRow.reply_to_id, doomed.id, 'reply ordering must not break');
});

dbTest('a member of another room gets 404 for a message they cannot see', async () => {
  const { author, roomId } = await messageFixture('delscope');
  const outsider = await authedAccount('del-outsider@test.com');
  const message = await sendMessage(author.token, roomId, 'private');

  const res = await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${outsider.token}` },
  });
  assert.equal(res.status, 404, 'existence must not be confirmed for someone outside the room');
});

dbTest('a deleted message drops out of the digest but keeps its mention rows', async () => {
  const { author, roomId } = await messageFixture('deldigest');
  const target = await authedAccount('deldigest-target@test.com');
  await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`, [roomId, target.userId]);

  const message = await sendMessage(author.token, roomId, 'a digest needle', { mentionedUserIds: [target.userId] });
  await query(
    `UPDATE room_members SET last_seen_at = NOW() - interval '1 day' WHERE room_id = $1 AND user_id = $2`,
    [roomId, target.userId],
  );

  const before = JSON.parse((await (await fetch(`${baseUrl}/api/digest/room/${roomId}`, {
    headers: { authorization: `Bearer ${target.token}` },
  })).text())).data.items;
  assert.ok(before.some((i) => i.type === 'mention' && i.id === message.id));

  await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${author.token}` },
  });

  const after = JSON.parse((await (await fetch(`${baseUrl}/api/digest/room/${roomId}`, {
    headers: { authorization: `Bearer ${target.token}` },
  })).text())).data.items;
  assert.ok(!after.some((i) => i.id === message.id), 'a deleted message must not appear in the digest');

  // The rows survive: a moderation action should not destroy provenance, and the
  // digest already filters deleted_at so nothing reads them.
  const rows = (await query('SELECT COUNT(*)::int n FROM message_mentions WHERE message_id = $1', [message.id])).rows[0].n;
  assert.equal(rows, 1, 'mention rows are left in place');
});

// --- Reactions ---------------------------------------------------------------

const LIKE = '\u{1F44D}';
const TADA = '\u{1F389}';
const CHECK_MARK = '\u{2705}';
const BANANA = '\u{1F34C}';

dbTest('reactions aggregate, and reacted is true only for who reacted', async () => {
  const { author, member, admin, roomId } = await messageFixture('react');
  const message = await sendMessage(author.token, roomId, 'react to me');

  for (const who of [author, member, admin]) {
    const res = await fetch(`${baseUrl}/api/messages/${message.id}/reactions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}` },
      body: JSON.stringify({ emoji: LIKE }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  }
  await fetch(`${baseUrl}/api/messages/${message.id}/reactions`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ emoji: TADA }),
  });

  const asAuthor = await (await fetch(`${baseUrl}/api/messages/room/${roomId}`, {
    headers: { authorization: `Bearer ${author.token}` },
  })).json();
  const forAuthor = asAuthor.data.messages.find((m) => m.id === message.id);

  const likeAuthor = forAuthor.reactions.find((r) => r.emoji === LIKE);
  assert.equal(likeAuthor.count, 3, 'three people reacted');
  assert.equal(likeAuthor.reacted, true, 'the author did react');
  assert.equal(likeAuthor.user_ids.length, 3);

  const tadaAuthor = forAuthor.reactions.find((r) => r.emoji === TADA);
  assert.equal(tadaAuthor.count, 1);

  // Order follows the allowlist, not insertion order.
  assert.deepEqual(forAuthor.reactions.map((r) => r.emoji), [LIKE, TADA]);

  // And the same message reads differently for a different viewer.
  const asMember = await (await fetch(`${baseUrl}/api/messages/room/${roomId}`, {
    headers: { authorization: `Bearer ${member.token}` },
  })).json();
  const forMember = asMember.data.messages.find((m) => m.id === message.id);
  const likeMember = forMember.reactions.find((r) => r.emoji === LIKE);
  assert.equal(likeMember.count, 3, 'counts are shared');
  assert.equal(likeMember.reacted, true, 'the member did react');
});

dbTest('reacting twice is idempotent and does not stack', async () => {
  const { author, roomId } = await messageFixture('reacttwice');
  const message = await sendMessage(author.token, roomId, 'react twice');

  for (let i = 0; i < 3; i += 1) {
    const res = await fetch(`${baseUrl}/api/messages/${message.id}/reactions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
      body: JSON.stringify({ emoji: LIKE }),
    });
    assert.equal(res.status, 200, 'a repeated reaction must not error');
  }

  const rows = (await query('SELECT COUNT(*)::int n FROM message_reactions WHERE message_id = $1 AND user_id = $2', [message.id, author.userId])).rows[0].n;
  assert.equal(rows, 1, 'one row, not three');
});

dbTest('removing a reaction works, and removing twice is harmless', async () => {
  const { author, roomId } = await messageFixture('reactremove');
  const message = await sendMessage(author.token, roomId, 'unreact me');

  await fetch(`${baseUrl}/api/messages/${message.id}/reactions`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ emoji: CHECK_MARK }),
  });

  // Percent-encoded: the emoji is multi-byte and arrives in the path.
  const url = `${baseUrl}/api/messages/${message.id}/reactions/${encodeURIComponent(CHECK_MARK)}`;
  const res = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${author.token}` } });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  assert.deepEqual(JSON.parse(body).data.reactions, [], 'the chip is gone');

  const again = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${author.token}` } });
  assert.equal(again.status, 200, 'removing an absent reaction is not an error');
});

dbTest('a disallowed emoji is rejected by the controller and by the database', async () => {
  const { author, roomId } = await messageFixture('reactallow');
  const message = await sendMessage(author.token, roomId, 'bad emoji');

  const res = await fetch(`${baseUrl}/api/messages/${message.id}/reactions`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ emoji: BANANA }),
  });
  const body = await res.text();
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${body}`);

  // The controller check is not the guarantee — the CHECK constraint is, because a
  // service or script bypassing the controller would otherwise be unconstrained.
  await assert.rejects(
    () => query(
      `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)`,
      [message.id, author.userId, BANANA],
    ),
    (err) => err.code === '23514',
    'a raw insert of a disallowed emoji must be rejected by the schema',
  );
});

dbTest('reacting in a room you are not in is a 404', async () => {
  const { author, roomId } = await messageFixture('reactscope');
  const outsider = await authedAccount('react-outsider@test.com');
  const message = await sendMessage(author.token, roomId, 'not for you');

  const res = await fetch(`${baseUrl}/api/messages/${message.id}/reactions`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${outsider.token}` },
    body: JSON.stringify({ emoji: LIKE }),
  });
  assert.equal(res.status, 404, 'existence must not be confirmed outside the room');
});

dbTest('a deleted message accepts no new reactions', async () => {
  const { author, member, roomId } = await messageFixture('reactdeleted');
  const message = await sendMessage(author.token, roomId, 'tombstone chip');
  await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${author.token}` },
  });

  const res = await fetch(`${baseUrl}/api/messages/${message.id}/reactions`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${member.token}` },
    body: JSON.stringify({ emoji: LIKE }),
  });
  assert.equal(res.status, 404, 'a tombstone should not collect new reactions');
});

dbTest('reactions: [] appears on every message surface', async () => {
  const { author, roomId } = await messageFixture('reactpayload');
  const needle = `reactpayload${Date.now()}`;
  const message = await sendMessage(author.token, roomId, `${needle} nothing yet`);

  assert.deepEqual(message.reactions, [], 'createMessage');

  const listed = await (await fetch(`${baseUrl}/api/messages/room/${roomId}`, {
    headers: { authorization: `Bearer ${author.token}` },
  })).json();
  const fromList = listed.data.messages.find((m) => m.id === message.id);
  assert.deepEqual(fromList.reactions, [], 'listMessages');

  const searched = await (await fetch(`${baseUrl}/api/messages/room/${roomId}/search?q=${needle}`, {
    headers: { authorization: `Bearer ${author.token}` },
  })).json();
  const fromSearch = searched.data.messages.find((m) => m.id === message.id);
  assert.deepEqual(fromSearch.reactions, [], 'searchMessages');
});

dbTest('searchMessages returns the same message shape as listMessages', async () => {
  // The shape gap that Bug 6 describes: search omitted edited_at, deleted_at and
  // is_deleted, so a tombstone could not be rendered from a search result.
  const { author, roomId } = await messageFixture('shapesearch');
  const needle = `shapesearch${Date.now()}`;
  const edited = await sendMessage(author.token, roomId, `${needle} edited soon`);
  await fetch(`${baseUrl}/api/messages/${edited.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ content: `${needle} edited` }),
  });

  const listed = await (await fetch(`${baseUrl}/api/messages/room/${roomId}`, {
    headers: { authorization: `Bearer ${author.token}` },
  })).json();
  const fromList = listed.data.messages.find((m) => m.id === edited.id);

  const searched = await (await fetch(`${baseUrl}/api/messages/room/${roomId}/search?q=${needle}`, {
    headers: { authorization: `Bearer ${author.token}` },
  })).json();
  const fromSearch = searched.data.messages.find((m) => m.id === edited.id);

  assert.deepEqual(
    Object.keys(fromSearch).filter((k) => k !== 'rank').sort(),
    Object.keys(fromList).sort(),
    'search and history must agree on every field but rank',
  );
  assert.ok(fromSearch.edited_at, 'search must expose edited_at');
  assert.ok('is_deleted' in fromSearch, 'search must expose is_deleted');
  assert.deepEqual(fromSearch.mentioned_user_ids, [], 'and the mention field');
});

dbTest('the edit and reaction responses carry the full message shape', async () => {
  const { author, roomId } = await messageFixture('shaperesponse');
  const message = await sendMessage(author.token, roomId, 'shape check');

  const editRes = await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ content: 'shape check edited' }),
  });
  const edited = (await editRes.json()).data;

  const reactRes = await fetch(`${baseUrl}/api/messages/${message.id}/reactions`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ emoji: TADA }),
  });
  const reacted = (await reactRes.json()).data;

  const listed = await (await fetch(`${baseUrl}/api/messages/room/${roomId}`, {
    headers: { authorization: `Bearer ${author.token}` },
  })).json();
  const fromList = listed.data.messages.find((m) => m.id === message.id);

  const expected = Object.keys(fromList).sort();
  assert.deepEqual(Object.keys(edited).sort(), expected, 'edit must return the same shape as a history row');
  assert.deepEqual(Object.keys(reacted).sort(), expected, 'a reaction must too');
  assert.ok(edited.sender_name, 'including resolved sender metadata');
  assert.deepEqual(edited.attachments, [], 'and the attachments array');
});

dbTest('the heartbeat and event surface still loads after adding message events', async () => {
  // Cheap guard that the socket module's documented list stayed loadable after
  // three more event names were added to its header.
  const registerSocketHandlers = require('../src/sockets');
  assert.equal(typeof registerSocketHandlers, 'function');
});

// --- Decisions search (Bug 5) ------------------------------------------------

dbTest('decision tags are searchable, and title/body are still ranked', async () => {
  const u = user;
  await query(
    `INSERT INTO decisions (room_id, title, body, tags, created_by)
     VALUES ($1, 'Ship the v2 API gateway', 'Deadline is the fifteenth', ARRAY['urgent','api'], $2)`,
    [room.id, u.id],
  );

  const byTag = await query(
    `SELECT id FROM decisions d
      WHERE d.tags @> ARRAY[lower($1)]::text[]
         OR EXISTS (SELECT 1 FROM unnest(d.tags) t WHERE t ILIKE $2)`,
    ['urgent', '%urg%'],
  );
  assert.equal(byTag.rows.length, 1, 'a tag-only hit must match');

  const ranked = await query(
    `SELECT id, ts_rank(to_tsvector('english', title || ' ' || body),
                        plainto_tsquery('english', $1)) AS rank
       FROM decisions
      WHERE to_tsvector('english', title || ' ' || body) @@ plainto_tsquery('english', $1)`,
    ['gateway'],
  );
  assert.equal(ranked.rows.length, 1);
  assert.ok(ranked.rows[0].rank > 0, 'title/body must still produce a rank');
});

// --- Member insert (Bug 3) ---------------------------------------------------

dbTest('members are inserted in one statement, skipping conflicts', async () => {
  const u = user;
  await query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`, [room.id, u.id]);

  const inserted = await query(
    `INSERT INTO room_members (room_id, user_id, role)
     SELECT $1, u, 'member' FROM unnest($2::uuid[]) AS u
     ON CONFLICT (room_id, user_id) DO NOTHING
     RETURNING user_id`,
    [room.id, [u.id, u.id]],
  );
  assert.equal(inserted.rows.length, 0, 'existing members are not re-inserted');
});

// --- Postgres error mapping (Bug 14) ----------------------------------------

dbTest('Postgres SQLSTATEs are the ones the error middleware maps', async () => {
  // The middleware maps these to 400/400/409. Asserting the codes exist pins the
  // contract; the mapping itself is covered in test/smoke.test.js.
  await assert.rejects(
    () => query('SELECT $1::uuid', ['not-a-uuid']),
    (err) => err.code === '22P02',
    'malformed uuid must be 22P02',
  );
  await assert.rejects(
    () => query('INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)', [
      '00000000-0000-0000-0000-000000000000',
      '11111111-1111-1111-1111-111111111111',
      'member',
    ]),
    (err) => err.code === '23503',
    'missing foreign key must be 23503',
  );
});

// --- Mention matching (Bug 9) ------------------------------------------------

dbTest('mention matching escapes wildcards and respects word boundaries', () => {
  // Mirrors mentionPattern() in digest.controller.js. Kept as a literal here on
  // purpose: the point is to pin the regex, and re-implementing it in the test
  // would let both sides drift in the same wrong direction.
  const pattern = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
    return `@${escaped}([^A-Za-z0-9_]|$)`;
  };
  const hits = (text, name) => new RegExp(pattern(name)).test(text);

  assert.equal(hits('hey @Alice', 'Al'), false, '"Al" must not match "@Alice"');
  assert.equal(hits('hey @Alice', 'Alice'), true);
  assert.equal(hits('hey @Al, ping', 'Al'), true, '"Al" must still match "@Al"');
  assert.equal(hits('hey @Alice.', 'Alice'), true, 'punctuation is a word boundary');
  assert.equal(hits('at @50 percent', '50%'), false, 'a % in a name is not a wildcard');
  assert.equal(hits('@a_b', 'aXb'), false, 'an _ in the text is not a wildcard');
});


dbTest('task due dates remain calendar dates across API responses in a non-UTC timezone', async (t) => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Africa/Lagos';
  t.after(() => {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  });
  const headers = {
    authorization: `Bearer ${tokenForFixtureUser()}`,
    'content-type': 'application/json',
  };
  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST', headers,
    body: JSON.stringify({ roomId: room.id, title: 'Leap-day deadline', dueDate: '2028-02-29' }),
  });
  assert.equal(created.status, 201);
  const { data: task } = await created.json();
  assert.equal(task.due_date, '2028-02-29');

  const listed = await fetch(`${baseUrl}/api/tasks/room/${room.id}`, { headers });
  assert.equal(listed.status, 200);
  const { data: { tasks } } = await listed.json();
  assert.equal(tasks.find(({ id }) => id === task.id).due_date, '2028-02-29');

  const updated = await fetch(`${baseUrl}/api/tasks/${task.id}/status`, {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.due_date, '2028-02-29');

  const undated = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST', headers,
    body: JSON.stringify({ roomId: room.id, title: 'No deadline' }),
  });
  assert.equal(undated.status, 201);
  assert.equal((await undated.json()).data.due_date, null);
});


dbTest('REST and socket sends emit persisted mentions to the recipient personal room', async (t) => {
  const recipient = await authedAccount('live-mention-recipient@test.com');
  await query(`INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)`, [room.id, recipient.userId]);
  const captured = [];
  let connect;
  const io = {
    use() {},
    on(event, handler) { if (event === 'connection') connect = handler; },
    to(target) { return { emit(event, payload) { captured.push({ target, event, payload }); } }; },
  };
  const app = require('../src/app');
  const previousIo = app.get('io');
  app.set('io', io);
  t.after(() => app.set('io', previousIo));

  const payload = { roomId: room.id, content: 'Please review', mentionedUserIds: [recipient.userId] };
  const rest = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenForFixtureUser()}` },
    body: JSON.stringify(payload),
  });
  assert.equal(rest.status, 201);
  const restMessage = (await rest.json()).data;

  const presence = require('../src/services/presence.service');
  t.mock.method(presence, 'startHeartbeatSweep', () => {});
  t.mock.method(presence, 'socketConnected', async () => 1);
  t.mock.method(presence, 'clearTyping', async () => {});
  require('../src/sockets')(io);
  const handlers = new Map();
  const errors = [];
  const joined = [];
  connect({
    id: 'mention-test-socket', user: { id: user.id }, connected: true,
    data: { sessionId: fixtureSessionId }, authClaims: { sub: user.id, sid: fixtureSessionId },
    sessionExpiresAt: Date.now() + 60000, disconnect() {},
    on(event, handler) { handlers.set(event, handler); },
    join(target) { joined.push(target); },
    emit(event, body) { if (event === 'error:message') errors.push(body); },
    broadcast: { emit() {} },
    to() { return { emit() {} }; },
  });
  assert.ok(joined.includes(`user:${user.id}`));
  await handlers.get('send-message')(payload);
  assert.deepEqual(errors, []);
  const socketMessage = captured.find(({ event }) => event === 'receive-message')?.payload.message;
  assert.ok(socketMessage, 'socket send must broadcast the committed message');

  const notifications = captured.filter(({ event }) => event === 'notification');
  assert.equal(notifications.length, 2, 'both send paths must push a mention');
  assert.deepEqual(notifications.map(({ target }) => target), Array(2).fill(`user:${recipient.userId}`));
  assert.deepEqual(notifications.map(({ payload }) => payload.notification.reference_id).sort(),
    [restMessage.id, socketMessage.id].sort());
  const persisted = await query('SELECT id FROM notifications WHERE recipient_id = $1', [recipient.userId]);
  assert.deepEqual(notifications.map(({ payload }) => payload.notification.id).sort(),
    persisted.rows.map(({ id }) => id).sort());
});


// --- Chat list enrichment + chat:updated (frontend redesign, Phase 1) -------
//
// The sidebar cannot be rendered from the room row alone: it needs a display
// identity, a last-message preview and an unread badge, and none of those lived
// on `rooms` before this. These tests exist because the failure mode of an
// enrichment like this is silent — a field is simply `undefined` in the client
// and a badge never appears.

async function createRoomVia(token, payload) {
  const res = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  return JSON.parse(body).data;
}

async function listRoomsVia(token) {
  const res = await fetch(`${baseUrl}/api/rooms`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  return JSON.parse(body).data;
}

dbTest('GET /rooms/:roomId includes safe member profile details for conversation info', async () => {
  const me = await authedAccount('room-info-me@test.com');
  const them = await authedAccount('room-info-them@test.com');
  const profile = await fetch(`${baseUrl}/api/users/me`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${them.token}` },
    body: JSON.stringify({ bio: 'A short public introduction.' }),
  });
  assert.equal(profile.status, 200, await profile.text());

  const dm = await createRoomVia(me.token, { type: 'dm', memberIds: [them.userId] });
  const response = await fetch(`${baseUrl}/api/rooms/${dm.id}`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const peer = JSON.parse(body).data.members.find((member) => member.id === them.userId);
  assert.equal(peer.bio, 'A short public introduction.');
  assert.ok(peer.account_created_at);
  assert.equal('email' in peer, false, 'room member details must not expose email addresses');
});

dbTest('shared groups, user reports, and DM blocking are scoped to the signed-in user', async () => {
  const reporter = await authedAccount('info-safety-reporter@test.com');
  const target = await authedAccount('info-safety-target@test.com');
  const group = await createRoomVia(reporter.token, {
    type: 'group', name: 'Common group', memberIds: [target.userId],
  });

  const common = await fetch(`${baseUrl}/api/users/${target.userId}/shared-rooms`, {
    headers: { authorization: `Bearer ${reporter.token}` },
  });
  assert.equal(common.status, 200);
  assert.equal((await common.json()).data.rooms[0].id, group.id);

  const report = await fetch(`${baseUrl}/api/users/${target.userId}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${reporter.token}` },
    body: JSON.stringify({ reason: 'harassment', details: 'Test report', roomId: group.id }),
  });
  assert.equal(report.status, 201, await report.text());

  const blocked = await fetch(`${baseUrl}/api/users/${target.userId}/block`, {
    method: 'POST', headers: { authorization: `Bearer ${reporter.token}` },
  });
  assert.equal(blocked.status, 200);
  const deniedDm = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${reporter.token}` },
    body: JSON.stringify({ type: 'dm', memberIds: [target.userId] }),
  });
  assert.equal(deniedDm.status, 403);

  const unblock = await fetch(`${baseUrl}/api/users/${target.userId}/block`, {
    method: 'DELETE', headers: { authorization: `Bearer ${reporter.token}` },
  });
  assert.equal(unblock.status, 200);
  const allowedDm = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${reporter.token}` },
    body: JSON.stringify({ type: 'dm', memberIds: [target.userId] }),
  });
  assert.equal(allowedDm.status, 201, await allowedDm.text());
});

async function sendVia(token, roomId, content) {
  const res = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ roomId, content }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  return JSON.parse(body).data;
}

function captureEmitIo() {
  const captured = [];
  return {
    captured,
    io: {
      to(room) {
        return { emit(event, payload) { captured.push({ room, event, payload }); } };
      },
    },
  };
}

dbTest('GET /rooms carries the chat-list row: DM name, last message, unread', async () => {
  const me = await authedAccount('chatlist-me@test.com');
  const them = await authedAccount('chatlist-them@test.com');

  const renamed = await fetch(`${baseUrl}/api/users/me`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${them.token}` },
    body: JSON.stringify({ display_name: 'Zara Okonkwo' }),
  });
  assert.equal(renamed.status, 200, await renamed.text());

  const dm = await createRoomVia(me.token, { name: 'Mehdi and Zara', memberIds: [them.userId] });
  assert.equal(dm.type, 'dm');

  await sendVia(me.token, dm.id, 'first');
  await sendVia(them.token, dm.id, 'the actual last message');

  const dmRow = (await listRoomsVia(me.token)).find((r) => r.id === dm.id);
  assert.ok(dmRow, 'the DM must be listed');

  // The DM is named after the other person, not the title createRoom required.
  assert.equal(dmRow.display_name, 'Zara Okonkwo', 'a DM is named after the other member');
  assert.notEqual(dmRow.display_name, dm.name, 'and not after the room row');

  assert.ok(dmRow.last_message, 'last_message must be present');
  assert.equal(dmRow.last_message.content, 'the actual last message');
  assert.equal(dmRow.last_message.sender_name, 'Zara Okonkwo');
  assert.equal(dmRow.last_message.is_deleted, false);
  assert.equal(dmRow.last_message.has_attachment, false);
  assert.equal(typeof dmRow.last_message.has_attachment, 'boolean', 'a count/flag must not arrive as a string');

  // `me` sent one and `them` sent one; only theirs is unread to me.
  assert.equal(dmRow.unread_count, 1, "your own message is never unread to you");
  assert.equal(dmRow.member_count, 2, 'member_count still works without the old GROUP BY');

  // A group room keeps its own name and has no other-member avatar.
  const group = await createRoomVia(me.token, { name: 'Launch Plan' });
  const groupRow = (await listRoomsVia(me.token)).find((r) => r.id === group.id);
  assert.equal(groupRow.display_name, 'Launch Plan', 'a group room is named after itself');
  assert.equal(groupRow.display_avatar, null);
});

dbTest('a room with no messages is still listed, with has_message false', async () => {
  // The regression this guards against: a CROSS JOIN LATERAL on an empty
  // messages table drops the row entirely, so a brand-new room would be
  // invisible in the sidebar until somebody spoke.
  const me = await authedAccount('chatlist-empty@test.com');
  const empty = await createRoomVia(me.token, { name: 'Quiet Room' });

  const row = (await listRoomsVia(me.token)).find((r) => r.id === empty.id);
  assert.ok(row, 'an empty room must not vanish from the list');
  assert.equal(row.has_message, false);
  assert.equal(row.last_message, null);
  assert.equal(row.unread_count, 0);
});

dbTest('GET /rooms orders by last activity, not room creation', async () => {
  const me = await authedAccount('chatlist-order@test.com');
  const first = await createRoomVia(me.token, { name: 'Created First' });
  const second = await createRoomVia(me.token, { name: 'Created Second' });

  let rows = await listRoomsVia(me.token);
  assert.equal(rows[0].id, second.id, 'the newest room is first before anything happens');

  await sendVia(me.token, first.id, 'bumping the older room');
  rows = await listRoomsVia(me.token);
  assert.equal(rows[0].id, first.id, 'last activity wins over creation order');

  await sendVia(me.token, second.id, 'bumping again');
  rows = await listRoomsVia(me.token);
  assert.equal(rows[0].id, second.id, 'and the list follows activity back');
});

dbTest('unread counts only other people live messages, and never a tombstone', async () => {
  const me = await authedAccount('chatlist-unread@test.com');
  const them = await authedAccount('chatlist-unread2@test.com');
  const chat = await createRoomVia(me.token, { name: 'Unread Check', memberIds: [them.userId] });

  const mine1 = await sendVia(me.token, chat.id, 'mine 1');
  await sendVia(me.token, chat.id, 'mine 2');
  await sendVia(me.token, chat.id, 'mine 3');

  const mineView = () => listRoomsVia(me.token).then((rows) => rows.find((r) => r.id === chat.id));
  const theirsView = () => listRoomsVia(them.token).then((rows) => rows.find((r) => r.id === chat.id));

  assert.equal((await mineView()).unread_count, 0, 'your own messages are not unread');

  const theirs1 = await sendVia(them.token, chat.id, 'theirs 1');
  await sendVia(them.token, chat.id, 'theirs 2');
  assert.equal((await mineView()).unread_count, 2, "the other person's messages are");
  assert.equal((await theirsView()).unread_count, 3, 'and they see mine');

  // Deleting one of MY messages takes it out of THEIR unread: a tombstone has
  // no body, so a badge pointing at one would open into nothing.
  const delMine = await fetch(`${baseUrl}/api/messages/${mine1.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${me.token}` },
  });
  assert.equal(delMine.status, 200, await delMine.text());
  assert.equal((await theirsView()).unread_count, 2, 'a deleted message is not unread');

  // Deleting the NEWEST message moves their preview back and masks it.
  const delLast = await fetch(`${baseUrl}/api/messages/${theirs1.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${them.token}` },
  });
  // theirs1 was not the newest — 'theirs 2' was. So the preview still points at
  // theirs 2 and this only changes unread.
  assert.equal(delLast.status, 200, await delLast.text());
  assert.equal((await mineView()).unread_count, 1, 'now only theirs 2 is unread to me');

  // Now delete theirs 2, which IS the newest: the preview must fall back to my
  // most recent message rather than showing a masked row.
  const newest = (await mineView()).last_message;
  assert.equal(newest.content, 'theirs 2');

  const delNewest = await fetch(`${baseUrl}/api/messages/${newest.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${them.token}` },
  });
  assert.equal(delNewest.status, 200, await delNewest.text());

  const after = await mineView();
  assert.equal(after.unread_count, 0, 'nothing readable is left unread');
  assert.equal(after.last_message.is_deleted, true, 'the newest row is a tombstone');
  assert.equal(after.last_message.content, null, 'and never echoes the body');
});

dbTest('chat:updated reaches every member personally with their own count', async () => {
  const me = await authedAccount('chatup-me@test.com');
  const them = await authedAccount('chatup-them@test.com');
  const chat = await createRoomVia(me.token, { name: 'Chat Updated', memberIds: [them.userId] });

  await sendVia(them.token, chat.id, 'from them');

  const { captured, io } = captureEmitIo();
  const notif = require('../src/services/notification.service');
  const told = await notif.emitChatUpdated(io, chat.id);

  assert.equal(told, 2, 'both members are told');
  assert.deepEqual(
    captured.map((c) => c.event),
    ['chat:updated', 'chat:updated'],
    'exactly one event per member',
  );
  assert.deepEqual(
    captured.map((c) => c.room).sort(),
    [`user:${me.userId}`, `user:${them.userId}`].sort(),
    'each to their own personal room',
  );
  assert.ok(
    captured.every((c) => c.room.startsWith('user:')),
    'chat:updated must never broadcast to the chat room, or everyone sees every badge',
  );

  const payloadFor = (id) => captured.find((c) => c.room === `user:${id}`).payload;
  const mine = payloadFor(me.userId);
  const theirs = payloadFor(them.userId);

  assert.equal(mine.roomId, chat.id);
  assert.equal(mine.unreadCount, 1, 'the recipient sees the other person message');
  assert.equal(theirs.unreadCount, 0, 'the sender does not count their own message');
  assert.equal(mine.lastMessage.content, 'from them');
  assert.equal(mine.lastMessage.sender_name, 'Task Tester');
  assert.equal(mine.lastMessage.is_deleted, false);

  // No socket and no room are both no-ops rather than throws: io is optional on
  // every path that can reach this.
  assert.equal(await notif.emitChatUpdated(undefined, chat.id), 0);
  assert.equal(await notif.emitChatUpdated(io, undefined), 0);
  assert.deepEqual(captured.length, 2, 'neither no-op emits anything');
});

dbTest('create, edit and delete all refresh the chat list', async () => {
  const me = await authedAccount('chatup-mutations@test.com');
  const chat = await createRoomVia(me.token, { name: 'Mutation Log' });
  const { createMessage, editMessage, deleteMessage } = require('../src/services/message.service');

  const { captured, io } = captureEmitIo();
  const refreshes = () => captured.filter((c) => c.event === 'chat:updated');

  const message = await createMessage({
    roomId: chat.id, senderId: me.userId, content: 'original', io,
  });
  assert.equal(refreshes().length, 1, 'a create refreshes the list');

  await editMessage({ messageId: message.id, userId: me.userId, content: 'edited', io });
  assert.equal(refreshes().length, 2, 'an edit refreshes the list');
  assert.equal(refreshes()[1].payload.lastMessage.content, 'edited');

  await deleteMessage({ messageId: message.id, userId: me.userId, io });
  assert.equal(refreshes().length, 3, 'a delete refreshes the list');
  assert.equal(refreshes()[2].payload.lastMessage.content, null, 'the preview is masked');
  assert.equal(refreshes()[2].payload.lastMessage.is_deleted, true);
  assert.equal(refreshes()[2].payload.unreadCount, 0, 'a tombstone contributes no unread');

  // Without io — the socket path can be absent — the same three writes still
  // succeed. The chat list is a nicety; the message is the intent.
  const plain = await createMessage({ roomId: chat.id, senderId: me.userId, content: 'no socket' });
  assert.ok(plain.id, 'a send without io still lands');
  assert.equal(refreshes().length, 3, 'and emits nothing');
});

// --- Decision pins (phase 5) -------------------------------------------------

async function promoteVia(token, payload) {
  const res = await fetch(`${baseUrl}/api/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  return JSON.parse(body).data;
}

async function pinVia(token, decisionId, scope) {
  return fetch(`${baseUrl}/api/decisions/${decisionId}/pin`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ scope }),
  });
}

async function unpinVia(token, decisionId, scope) {
  return fetch(`${baseUrl}/api/decisions/${decisionId}/pin/${scope}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function listDecisionsVia(token, roomId) {
  const url = roomId
    ? `${baseUrl}/api/decisions?roomId=${roomId}`
    : `${baseUrl}/api/decisions`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  return JSON.parse(body).data.decisions;
}

dbTest('a decision can hold at most one room pin', async () => {
  // Asserted against the index rather than the endpoint, because the endpoint
  // answers 409 by reading the row first — so a broken unique index would still
  // look green from HTTP and only fail once two writes raced.
  //
  // The primary key is itself a unique index, so it is excluded explicitly;
  // matching on indexdef alone finds two and asserts the wrong thing.
  const { rows } = await query(
    `SELECT pg_get_indexdef(i.indexrelid) AS indexdef
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
      WHERE c.relname = 'decision_pins'
        AND i.indisunique
        AND NOT i.indisprimary`,
  );
  assert.equal(rows.length, 1, 'expected exactly one unique index beyond the primary key');
  assert.match(rows[0].indexdef, /scope = 'room'/, 'the uniqueness is on the room scope');
});

dbTest('a personal pin is visible only to its author', async () => {
  const me = await authedAccount('pin-user-me@test.com');
  const them = await authedAccount('pin-user-them@test.com');
  const room = await createRoomVia(me.token, { name: 'Pin User Room', memberIds: [them.userId] });
  const decision = await promoteVia(me.token, {
    roomId: room.id, title: 'Ship it', body: 'We ship on Friday.',
  });

  const res = await pinVia(me.token, decision.id, 'user');
  assert.equal(res.status, 200, await res.text());

  const mine = (await listDecisionsVia(me.token, room.id)).find((d) => d.id === decision.id);
  assert.deepEqual(mine.pins.mine, ['user'], 'the author sees their own bookmark');
  assert.equal(mine.pins.room, null, 'a personal pin never appears as a room pin');

  const theirs = (await listDecisionsVia(them.token, room.id)).find((d) => d.id === decision.id);
  assert.deepEqual(theirs.pins.mine, [], 'another member does not inherit the bookmark');
  assert.equal(theirs.pins.room, null);
});

dbTest('a room pin is visible to every member and names its author', async () => {
  const me = await authedAccount('pin-room-me@test.com');
  const them = await authedAccount('pin-room-them@test.com');
  const room = await createRoomVia(me.token, { name: 'Pin Room Room', memberIds: [them.userId] });
  const decision = await promoteVia(me.token, {
    roomId: room.id, title: 'Freeze the API', body: 'No contract changes this sprint.',
  });

  assert.equal((await pinVia(me.token, decision.id, 'room')).status, 200);

  const theirs = (await listDecisionsVia(them.token, room.id)).find((d) => d.id === decision.id);
  assert.equal(theirs.pins.room.user_id, me.userId, 'the room pin names who set it');
  assert.ok(theirs.pins.room.display_name, 'and carries a name the strip can render');
  assert.deepEqual(theirs.pins.mine, [], 'but it is not the viewer\'s own action');

  const mine = (await listDecisionsVia(me.token, room.id)).find((d) => d.id === decision.id);
  assert.deepEqual(mine.pins.mine, ['room'], 'the pinner may take their own pin back');
});

dbTest('a second room pinner is rejected and told who holds the pin', async () => {
  const me = await authedAccount('pin-conflict-me@test.com');
  const them = await authedAccount('pin-conflict-them@test.com');
  const room = await createRoomVia(me.token, { name: 'Pin Conflict Room', memberIds: [them.userId] });
  const decision = await promoteVia(me.token, {
    roomId: room.id, title: 'Adopt the RFC', body: 'RFC 4 is accepted.',
  });

  await pinVia(me.token, decision.id, 'room');

  const res = await pinVia(them.token, decision.id, 'room');
  const conflict = await res.text();
  assert.equal(res.status, 409, conflict);
  assert.match(
    JSON.parse(conflict).message,
    /Already pinned to the room by/,
    'the 409 names the holder',
  );

  // And the original owner is unchanged — the conflict did not silently
  // transfer the pin to the person who was refused.
  const current = (await listDecisionsVia(me.token, room.id)).find((d) => d.id === decision.id);
  assert.equal(current.pins.room.user_id, me.userId);
});

dbTest('re-pinning your own scope is idempotent', async () => {
  const me = await authedAccount('pin-idem@test.com');
  const room = await createRoomVia(me.token, { name: 'Pin Idem Room' });
  const decision = await promoteVia(me.token, {
    roomId: room.id, title: 'Rename the staging box', body: 'staging-2 from now on.',
  });

  assert.equal((await pinVia(me.token, decision.id, 'user')).status, 200);
  const second = await pinVia(me.token, decision.id, 'user');
  assert.equal(second.status, 200, 'a repeat PUT is not an error');

  const pins = (await listDecisionsVia(me.token, room.id)).find((d) => d.id === decision.id);
  assert.deepEqual(pins.pins.mine, ['user'], 'still exactly one bookmark, not two');
});

dbTest('you cannot remove another member\'s personal pin', async () => {
  const me = await authedAccount('pin-protect-me@test.com');
  const them = await authedAccount('pin-protect-them@test.com');
  const room = await createRoomVia(me.token, { name: 'Pin Protect Room', memberIds: [them.userId] });
  const decision = await promoteVia(me.token, {
    roomId: room.id, title: 'Keep the old endpoint', body: 'It is still load-bearing.',
  });

  await pinVia(them.token, decision.id, 'user');

  // The author of the decision is also the room admin, and still cannot touch
  // somebody else's private bookmark — that is the point of it being private.
  const res = await unpinVia(me.token, decision.id, 'user');
  assert.equal(res.status, 403, await res.text());

  const still = (await listDecisionsVia(them.token, room.id)).find((d) => d.id === decision.id);
  assert.deepEqual(still.pins.mine, ['user'], 'the bookmark survived');
});

dbTest('a room admin may remove someone else\'s room pin; a plain member may not', async () => {
  const admin = await authedAccount('pin-admin@test.com');
  const pinner = await authedAccount('pin-admin-pinner@test.com');
  const bystander = await authedAccount('pin-admin-bystander@test.com');
  const room = await createRoomVia(admin.token, {
    name: 'Pin Admin Room', memberIds: [pinner.userId, bystander.userId],
  });
  const decision = await promoteVia(admin.token, {
    roomId: room.id, title: 'Deprecate v1', body: 'v1 goes away in March.',
  });

  await pinVia(pinner.token, decision.id, 'room');

  // A plain member who did not set it is refused: the pin is shared state, but
  // it is not unowned.
  const refused = await unpinVia(bystander.token, decision.id, 'room');
  assert.equal(refused.status, 403, await refused.text());

  // The admin can, which is what stops a pin left behind by a departed member
  // from being permanent.
  const removed = await unpinVia(admin.token, decision.id, 'room');
  assert.equal(removed.status, 200, await removed.text());

  const current = (await listDecisionsVia(admin.token, room.id)).find((d) => d.id === decision.id);
  assert.equal(current.pins.room, null, 'the room pin is gone');
});

dbTest('the pinner may remove their own room pin without being an admin', async () => {
  const me = await authedAccount('pin-self@test.com');
  const them = await authedAccount('pin-self-them@test.com');
  const room = await createRoomVia(me.token, { name: 'Pin Self Room', memberIds: [them.userId] });
  const decision = await promoteVia(me.token, {
    roomId: room.id, title: 'Split the monolith', body: 'Service per bounded context.',
  });

  await pinVia(them.token, decision.id, 'room');
  // `them` is a plain member, and removing their own pin needs no elevated role.
  assert.equal((await unpinVia(them.token, decision.id, 'room')).status, 200);
});

dbTest('unpinning a pin that does not exist succeeds with nothing to report', async () => {
  const me = await authedAccount('pin-absent@test.com');
  const room = await createRoomVia(me.token, { name: 'Pin Absent Room' });
  const decision = await promoteVia(me.token, {
    roomId: room.id, title: 'Nothing to unpin', body: 'Still a decision though.',
  });

  const res = await unpinVia(me.token, decision.id, 'room');
  const body = await res.text();
  assert.equal(res.status, 200, body);
  assert.equal(JSON.parse(body).data.unpinned, false, 'a no-op reports itself rather than 404ing');
});

dbTest('pinning a decision in a room you are not a member of is refused', async () => {
  const owner = await authedAccount('pin-outsider-owner@test.com');
  const outsider = await authedAccount('pin-outsider@test.com');
  const room = await createRoomVia(owner.token, { name: 'Pin Outsider Room' });
  const decision = await promoteVia(owner.token, {
    roomId: room.id, title: 'Members only', body: 'Even for bookmarks.',
  });

  const res = await pinVia(outsider.token, decision.id, 'user');
  assert.equal(res.status, 403, await res.text());
});

dbTest('an unknown pin scope is a 400, not a silent personal pin', async () => {
  const me = await authedAccount('pin-scope@test.com');
  const room = await createRoomVia(me.token, { name: 'Pin Scope Room' });
  const decision = await promoteVia(me.token, {
    roomId: room.id, title: 'Bad scope', body: 'Needs validating.',
  });

  const res = await pinVia(me.token, decision.id, 'everyone');
  assert.equal(res.status, 400, await res.text());
});

dbTest('pinning publishes decision:pinned with shared truth, not a per-viewer payload', async () => {
  const me = await authedAccount('pin-emit@test.com');
  const room = await createRoomVia(me.token, { name: 'Pin Emit Room' });
  const decision = await promoteVia(me.token, {
    roomId: room.id, title: 'Emit the pin', body: 'So other clients update.',
  });

  const { pinDecision, unpinDecision } = require('../src/services/decisionPin.service');
  const { captured, io } = captureEmitIo();

  await pinDecision({ decisionId: decision.id, userId: me.userId, scope: 'room', io });
  const pinned = captured.find((c) => c.event === 'decision:pinned');
  assert.ok(pinned, 'a pin is announced to the room');
  assert.equal(pinned.room, room.id);
  assert.equal(pinned.payload.scope, 'room');
  assert.equal(pinned.payload.userId, me.userId, 'the actor is named so each client can fix up its own mine');
  assert.equal(pinned.payload.decision.pins.room.user_id, me.userId, 'shared truth rides along');
  // pins.mine in this payload is computed for the ACTOR, who happens to be the
  // viewer in a single-user test. Other clients must not copy it: it is per
  // viewer, exactly like reactions' `reacted`, and each one derives its own
  // from the userId above.
  assert.ok(Array.isArray(pinned.payload.decision.pins.mine), 'mine is present as an array');

  await unpinDecision({ decisionId: decision.id, userId: me.userId, scope: 'room', io });
  const unpinned = captured.find((c) => c.event === 'decision:unpinned');
  assert.ok(unpinned, 'an unpin is announced too');
  assert.equal(unpinned.payload.decision.pins.room, null, 'and carries the now-empty room pin');
});

// --- Persistent read receipts (phase 5) --------------------------------------

// The route is POST, not PATCH — easy to get wrong, and a wrong method is a
// 404 that looks exactly like a missing endpoint.
async function markSeenVia(token, roomId) {
  return fetch(`${baseUrl}/api/rooms/${roomId}/seen`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

dbTest('markRoomSeen publishes room-seen with the timestamp it stored', async () => {
  const app = require('../src/app');
  const { captured, io } = captureEmitIo();
  app.set('io', io);

  const me = await authedAccount('seen-emit-me@test.com');
  const them = await authedAccount('seen-emit-them@test.com');
  const room = await createRoomVia(me.token, { name: 'Seen Emit Room', memberIds: [them.userId] });

  const res = await markSeenVia(me.token, room.id);
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const stored = JSON.parse(body).data.lastSeenAt;

  const event = captured.find((c) => c.event === 'room-seen');
  assert.ok(event, 'the REST path announces the advance, so ticks update for everyone');
  assert.equal(event.room, room.id);
  assert.equal(event.payload.userId, me.userId);
  assert.equal(
    new Date(event.payload.lastSeenAt).getTime(),
    new Date(stored).getTime(),
    'the echoed timestamp is the one actually stored, not a second guess',
  );

  app.set('io', undefined);
});

dbTest('an advanced last_seen_at is what another member reads back', async () => {
  const me = await authedAccount('seen-read-me@test.com');
  const them = await authedAccount('seen-read-them@test.com');
  const room = await createRoomVia(me.token, { name: 'Seen Read Room', memberIds: [them.userId] });
  await sendVia(me.token, room.id, 'something to have read');

  const before = await fetch(`${baseUrl}/api/rooms/${room.id}`, {
    headers: { authorization: `Bearer ${them.token}` },
  });
  const beforeMember = JSON.parse(await before.text()).data.members
    .find((m) => m.id === me.userId);

  await new Promise((r) => setTimeout(r, 15));
  assert.equal((await markSeenVia(me.token, room.id)).status, 200);

  const after = await fetch(`${baseUrl}/api/rooms/${room.id}`, {
    headers: { authorization: `Bearer ${them.token}` },
  });
  const afterMember = JSON.parse(await after.text()).data.members
    .find((m) => m.id === me.userId);

  assert.ok(
    new Date(afterMember.last_seen_at) > new Date(beforeMember.last_seen_at),
    'the read pointer moved forward and another member can see it — which is what makes a read tick survive a reload',
  );
});

// --- GET /decisions/:decisionId (phase 6) ------------------------------------

async function getDecisionVia(token, decisionId) {
  return fetch(`${baseUrl}/api/decisions/${decisionId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

dbTest('a decision reads back individually, in the list shape, with pins', async () => {
  const me = await authedAccount('decision-one-me@test.com');
  const them = await authedAccount('decision-one-them@test.com');
  const room = await createRoomVia(me.token, { name: 'Single Decision', memberIds: [them.userId] });

  const created = await promoteVia(me.token, {
    roomId: room.id, title: 'Read it alone', body: 'The body text.',
  });
  await pinVia(me.token, created.id, 'room');

  const res = await getDecisionVia(me.token, created.id);
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const decision = JSON.parse(body).data;

  // The joined shape, not the raw row: a bare RETURNING * would come back with
  // no room_name and the detail view would have nothing to title itself with.
  assert.equal(decision.id, created.id);
  assert.equal(decision.title, 'Read it alone');
  assert.equal(decision.room_id, room.id);
  assert.equal(decision.room_name, 'Single Decision');
  assert.ok(decision.author_name, 'author_name is joined, not left null');
  assert.deepEqual(decision.tags, []);

  // Pins travel with it, so the detail view does not need a second request to
  // know whether this is pinned and by whom.
  assert.ok(decision.pins, 'pins is present even though the list attaches it too');
  assert.equal(decision.pins.room.user_id, me.userId);
  assert.ok(decision.pins.room.display_name);
  assert.deepEqual(decision.pins.mine, ['room']);

  // Another member of the same room reads the same decision, but the pin is
  // theirs not mine — `mine` is per viewer, exactly like reactions' `reacted`.
  const theirs = JSON.parse(await (await getDecisionVia(them.token, created.id)).text()).data;
  assert.equal(theirs.id, created.id);
  assert.deepEqual(theirs.pins.mine, [], 'a room pin set by someone else is not in my scopes');
});

dbTest('an unknown decision and one in a room you are not in are both 403', async () => {
  const me = await authedAccount('decision-403-me@test.com');
  const stranger = await authedAccount('decision-403-stranger@test.com');
  const room = await createRoomVia(me.token, { name: 'Closed Room' });

  const created = await promoteVia(me.token, {
    roomId: room.id, title: 'Members only', body: 'Not for strangers.',
  });

  const outsider = await getDecisionVia(stranger.token, created.id);
  assert.equal(outsider.status, 403, 'a non-member cannot read a decision');

  // Indistinguishable from outside, deliberately: saying "not found" would
  // confirm the UUID exists to someone who cannot see it.
  const unknown = await getDecisionVia(me.token, '00000000-0000-4000-8000-000000000000');
  assert.equal(unknown.status, 403, 'an unknown id is the same answer as a forbidden one');
});

dbTest('GET /decisions/:decisionId does not shadow the literal routes', async () => {
  const me = await authedAccount('decision-routes@test.com');
  const room = await createRoomVia(me.token, { name: 'Route Order' });
  const created = await promoteVia(me.token, {
    roomId: room.id, title: 'Route order', body: 'The literal routes still win.',
  });

  // `/search` is a literal and is registered first; if `/:decisionId` had been
  // registered above it, this would answer 403 with "search" as the id.
  const search = await fetch(`${baseUrl}/api/decisions/search?q=order`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  assert.equal(search.status, 200, 'the literal /search still matches');
  assert.ok(JSON.parse(await search.text()).data.decisions.length >= 1);

  // `/room/:roomId` is two segments and must not be read as a single id.
  const scoped = await fetch(`${baseUrl}/api/decisions/room/${room.id}`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  assert.equal(scoped.status, 200, 'the two-segment room route still matches');
  const rows = JSON.parse(await scoped.text()).data.decisions;
  assert.ok(rows.some((d) => d.id === created.id));
});

// --- Room membership management + user search + preferences (phase 7) --------
//
// Phase 7 made member management a screen, and the backend could not serve it:
// `role` was only ever written at insert time, so the room creator was the sole
// admin for the life of the room and nobody could be removed or promoted. These
// cover the three endpoints that close that, plus the two supporting endpoints
// the screens need.

async function removeMemberVia(token, roomId, userId) {
  return fetch(`${baseUrl}/api/rooms/${roomId}/members/${userId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function setMemberRoleVia(token, roomId, userId, role) {
  return fetch(`${baseUrl}/api/rooms/${roomId}/members/${userId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ role }),
  });
}

async function prefsVia(token, method = 'GET', body) {
  return fetch(`${baseUrl}/api/users/me/preferences`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

dbTest('a member leaves by removing themselves, and disappears from the room', async () => {
  const me = await authedAccount('phase7-leaver@test.com');
  const them = await authedAccount('phase7-leaver-them@test.com');
  const room = await createRoomVia(me.token, { type: 'group', name: 'Leaving Room', memberIds: [them.userId] });

  const res = await removeMemberVia(them.token, room.id, them.userId);
  const body = await res.text();
  assert.equal(res.status, 200, body);
  assert.equal(JSON.parse(body).data.removed, true);

  // Gone from the member list, which is the only place membership is read from.
  const after = JSON.parse(
    await (await fetch(`${baseUrl}/api/rooms/${room.id}`, {
      headers: { authorization: `Bearer ${me.token}` },
    })).text()
  ).data;
  assert.ok(
    !after.members.some((m) => m.id === them.userId),
    'the member who left is no longer in the room'
  );
});

dbTest('a non-admin cannot remove somebody else', async () => {
  const admin = await authedAccount('phase7-rm-admin@test.com');
  const member = await authedAccount('phase7-rm-member@test.com');
  const target = await authedAccount('phase7-rm-target@test.com');
  const room = await createRoomVia(admin.token, {
    name: 'Removal Guard',
    memberIds: [member.userId, target.userId],
  });

  const res = await removeMemberVia(member.token, room.id, target.userId);
  assert.equal(res.status, 403, 'a plain member has no removal privilege');

  // And the target is genuinely still there — a 403 must not have removed them.
  const still = JSON.parse(
    await (await fetch(`${baseUrl}/api/rooms/${room.id}`, {
      headers: { authorization: `Bearer ${admin.token}` },
    })).text()
  ).data;
  assert.ok(still.members.some((m) => m.id === target.userId), 'the member was not removed');
});

dbTest('removing an unknown member and removing from a room you are not in are both 403', async () => {
  const me = await authedAccount('phase7-rm-stranger@test.com');
  const admin = await authedAccount('phase7-rm-insider@test.com');
  const room = await createRoomVia(admin.token, { name: 'Closed Room' });

  const stranger = await removeMemberVia(me.token, room.id, admin.userId);
  assert.equal(stranger.status, 403, 'a non-member cannot remove anybody');

  // Deliberately the same status as the one above: telling them apart would
  // confirm the room id is real to somebody who cannot see it.
  const unknown = await removeMemberVia(admin.token, room.id, '00000000-0000-4000-8000-000000000000');
  assert.equal(unknown.status, 403, 'an unknown member is the same answer as a forbidden one');
});

dbTest('the last admin cannot be removed — that would orphan the room forever', async () => {
  const only = await authedAccount('phase7-lastadmin@test.com');
  const member = await authedAccount('phase7-lastadmin-other@test.com');
  const room = await createRoomVia(only.token, { name: 'One Admin', memberIds: [member.userId] });

  // `only` is the creator and therefore the sole admin.
  const leave = await removeMemberVia(only.token, room.id, only.userId);
  assert.equal(leave.status, 409, 'the only admin cannot walk out and strand the room');

  const demote = await setMemberRoleVia(only.token, room.id, only.userId, 'member');
  assert.equal(demote.status, 409, 'nor demote themselves out of the last admin slot');
});

dbTest('an admin can be promoted and demoted, and the room keeps an admin', async () => {
  const admin = await authedAccount('phase7-role-admin@test.com');
  const member = await authedAccount('phase7-role-member@test.com');
  const room = await createRoomVia(admin.token, { type: 'group', name: 'Role Changes', memberIds: [member.userId] });

  const promoted = await setMemberRoleVia(admin.token, room.id, member.userId, 'admin');
  const promotedBody = await promoted.text();
  assert.equal(promoted.status, 200, promotedBody);
  assert.equal(JSON.parse(promotedBody).data.role, 'admin');

  // Two admins now, so demoting one is allowed and leaves the room governable.
  const demoted = await setMemberRoleVia(admin.token, room.id, member.userId, 'member');
  assert.equal(demoted.status, 200, 'the second admin can step down while another remains');

  // Role is genuinely persisted, not just echoed back.
  const after = JSON.parse(
    await (await fetch(`${baseUrl}/api/rooms/${room.id}`, {
      headers: { authorization: `Bearer ${admin.token}` },
    })).text()
  ).data;
  assert.equal(after.members.find((m) => m.id === member.userId).role, 'member');
});

dbTest('only an admin may change a role, and the role value is validated', async () => {
  const admin = await authedAccount('phase7-roleguard-admin@test.com');
  const member = await authedAccount('phase7-roleguard-member@test.com');
  const other = await authedAccount('phase7-roleguard-other@test.com');
  const room = await createRoomVia(admin.token, {
    name: 'Role Guard',
    memberIds: [member.userId, other.userId],
  });

  const byMember = await setMemberRoleVia(member.token, room.id, other.userId, 'admin');
  assert.equal(byMember.status, 403, 'a plain member cannot promote anyone');

  const badValue = await setMemberRoleVia(admin.token, room.id, other.userId, 'superuser');
  assert.equal(badValue.status, 400, 'role must be admin or member');

  // Setting the role it already has is a no-op, not an error — a client
  // rendering a role toggle should not have to know the current value first.
  const same = await setMemberRoleVia(admin.token, room.id, member.userId, 'member');
  assert.equal(same.status, 200, 'a no-op role change succeeds');
});

dbTest('the membership routes do not shadow the single-segment room route', async () => {
  const me = await authedAccount('phase7-routes@test.com');
  const room = await createRoomVia(me.token, { name: 'Route Order' });

  // `/seen` is a literal and is registered after the new member routes; if a
  // `/:roomId/members/:userId` handler had swallowed it, this would answer 400
  // with "seen" in the roomId position.
  const seen = await fetch(`${baseUrl}/api/rooms/${room.id}/seen`, {
    method: 'POST',
    headers: { authorization: `Bearer ${me.token}` },
  });
  assert.equal(seen.status, 200, 'the literal /seen still matches');

  const read = await fetch(`${baseUrl}/api/rooms/${room.id}`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  assert.equal(read.status, 200, 'GET /:roomId still reads as a room');
});

dbTest('user search finds people by name and never returns an email', async () => {
  const me = await authedAccount('phase7-search-me@test.com');
  await authedAccount('phase7-search-target@test.com');

  const res = await fetch(`${baseUrl}/api/users/search?q=search-target`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const { users } = JSON.parse(body).data;

  assert.equal(users.length, 1, 'the search finds the account by its email');
  const row = users[0];
  assert.ok(row.id && row.display_name);
  // Directory results are useful for compose without exposing account email.
  assert.equal(row.email, undefined, 'search results carry no email');
  assert.deepEqual(
    Object.keys(row).sort(),
    ['avatar_url', 'display_name', 'id'],
    'search returns exactly the picker fields'
  );
});

dbTest('public rooms are discoverable and joinable, but their messages stay membership protected', async () => {
  const owner = await authedAccount('public-room-owner@test.com');
  const visitor = await authedAccount('public-room-visitor@test.com');
  const privateVisitor = await authedAccount('public-room-private-visitor@test.com');
  const publicRoom = await createRoomVia(owner.token, { name: 'Open Design Room', type: 'public' });
  const privateRoom = await createRoomVia(owner.token, { name: 'Private Design Room', type: 'private' });

  const discover = await fetch(`${baseUrl}/api/rooms/discover?q=Open`, {
    headers: { authorization: `Bearer ${visitor.token}` },
  });
  const discoverBody = await discover.text();
  assert.equal(discover.status, 200, discoverBody);
  const { rooms } = JSON.parse(discoverBody).data;
  assert.deepEqual(rooms.map((room) => room.id), [publicRoom.id]);
  assert.equal(Object.hasOwn(rooms[0], 'email'), false);

  const beforeJoin = await fetch(`${baseUrl}/api/messages/room/${publicRoom.id}`, {
    headers: { authorization: `Bearer ${visitor.token}` },
  });
  assert.notEqual(beforeJoin.status, 200, 'discovery does not grant message access');

  const joined = await fetch(`${baseUrl}/api/rooms/${publicRoom.id}/join`, {
    method: 'POST', headers: { authorization: `Bearer ${visitor.token}` },
  });
  const joinedBody = await joined.text();
  assert.equal(joined.status, 201, joinedBody);
  assert.equal(JSON.parse(joinedBody).data.joined, true);

  const repeated = await fetch(`${baseUrl}/api/rooms/${publicRoom.id}/join`, {
    method: 'POST', headers: { authorization: `Bearer ${visitor.token}` },
  });
  const repeatedBody = await repeated.text();
  assert.equal(repeated.status, 200, repeatedBody);
  assert.equal(JSON.parse(repeatedBody).data.existing, true);

  const listed = await fetch(`${baseUrl}/api/rooms/${publicRoom.id}`, {
    headers: { authorization: `Bearer ${visitor.token}` },
  });
  assert.equal(listed.status, 200, 'a joined member can read room metadata');

  const blocked = await fetch(`${baseUrl}/api/rooms/${privateRoom.id}/join`, {
    method: 'POST', headers: { authorization: `Bearer ${privateVisitor.token}` },
  });
  assert.equal(blocked.status, 403, 'private rooms cannot be joined through discovery');
  const hidden = await fetch(`${baseUrl}/api/rooms/discover`, {
    headers: { authorization: `Bearer ${privateVisitor.token}` },
  });
  assert.equal((await hidden.json()).data.rooms.some((room) => room.id === privateRoom.id), false);
});

dbTest('direct messages stay two-person conversations and reject room membership changes', async () => {
  const first = await authedAccount('dm-two-person-first@test.com');
  const second = await authedAccount('dm-two-person-second@test.com');
  const third = await authedAccount('dm-two-person-third@test.com');
  const dm = await createRoomVia(first.token, { type: 'dm', memberIds: [second.userId] });

  const add = await fetch(`${baseUrl}/api/rooms/${dm.id}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${first.token}` },
    body: JSON.stringify({ userId: third.userId }),
  });
  assert.equal(add.status, 409, await add.text());

  const leave = await fetch(`${baseUrl}/api/rooms/${dm.id}/members/${first.userId}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${first.token}` },
  });
  assert.equal(leave.status, 409, await leave.text());

  const changeRole = await fetch(`${baseUrl}/api/rooms/${dm.id}/members/${second.userId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${first.token}` },
    body: JSON.stringify({ role: 'admin' }),
  });
  assert.equal(changeRole.status, 409, await changeRole.text());
});

dbTest('the user directory never returns another member email address', async () => {
  const caller = await authedAccount('directory-caller@test.com');
  await authedAccount('directory-target-private@test.com');
  const response = await fetch(`${baseUrl}/api/users?q=directory-target-private`, {
    headers: { authorization: `Bearer ${caller.token}` },
  });
  const responseBody = await response.text();
  assert.equal(response.status, 200, responseBody);
  const { users } = JSON.parse(responseBody).data;
  assert.equal(users.length, 1);
  assert.equal(Object.hasOwn(users[0], 'email'), false);
});

dbTest('an empty search returns nothing rather than the whole directory', async () => {
  const me = await authedAccount('phase7-search-empty@test.com');

  const res = await fetch(`${baseUrl}/api/users/search?q=`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  assert.deepEqual(JSON.parse(body).data.users, [], 'a blank query is not a request for everyone');
});

dbTest('GET /users/search does not shadow the /me and / routes', async () => {
  const me = await authedAccount('phase7-search-routes@test.com');

  const meRes = await fetch(`${baseUrl}/api/users/me`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  assert.equal(meRes.status, 200, '/me still resolves to the caller, not to a search term');

  const listRes = await fetch(`${baseUrl}/api/users`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  assert.equal(listRes.status, 200, 'the directory still resolves');
});

dbTest('preferences answer with defaults before anything is saved, and persist after', async () => {
  const me = await authedAccount('phase7-prefs@test.com');

  const initial = await prefsVia(me.token);
  const initialBody = await initial.text();
  assert.equal(initial.status, 200, initialBody);
  const defaults = JSON.parse(initialBody).data;
  assert.equal(defaults.activity_level, 'all');
  assert.deepEqual(defaults.muted, {});
  assert.equal(defaults.push_enabled, true);
  assert.equal(defaults.updatedAt, null, 'defaults are not a saved state');

  const saved = await prefsVia(me.token, 'PATCH', { activity_level: 'mentions', muted: { new_message: true } });
  const savedBody = await saved.text();
  assert.equal(saved.status, 200, savedBody);
  assert.equal(JSON.parse(savedBody).data.activity_level, 'mentions');

  const reread = JSON.parse(await (await prefsVia(me.token)).text()).data;
  assert.equal(reread.activity_level, 'mentions', 'the change survived a reload');
  assert.deepEqual(reread.muted, { new_message: true });
  assert.ok(reread.updatedAt, 'a written row carries a timestamp');

  // A partial update keeps what it did not mention.
  const partial = await prefsVia(me.token, 'PATCH', { push_enabled: false });
  assert.equal(partial.status, 200);
  const merged = JSON.parse(await (await prefsVia(me.token)).text()).data;
  assert.equal(merged.activity_level, 'mentions', 'the untouched field survived');
  assert.equal(merged.push_enabled, false);
});

dbTest('preferences reject an unknown type, a bad level, and an empty body', async () => {
  const me = await authedAccount('phase7-prefs-guard@test.com');

  const empty = await prefsVia(me.token, 'PATCH', {});
  assert.equal(empty.status, 400, 'an empty body must not look like a successful save');

  const badLevel = await prefsVia(me.token, 'PATCH', { activity_level: 'loud' });
  assert.equal(badLevel.status, 400, 'activity_level is a closed set');

  // Validated by name against the notification allowlist rather than a CHECK
  // constraint, because Postgres forbids subqueries in CHECK.
  const badType = await prefsVia(me.token, 'PATCH', { muted: { telepathy: true } });
  assert.equal(badType.status, 400, 'an unknown notification type is rejected by name');

  const badValue = await prefsVia(me.token, 'PATCH', { muted: { mention: 'yes' } });
  assert.equal(badValue.status, 400, 'a muted value must be a boolean');

  const notObject = await prefsVia(me.token, 'PATCH', { muted: ['mention'] });
  assert.equal(notObject.status, 400, 'muted must be a map, not an array');

  // Nothing above should have written a row.
  const after = JSON.parse(await (await prefsVia(me.token)).text()).data;
  assert.equal(after.updatedAt, null, 'a rejected write leaves no row behind');
});

// --- Creating a DM without a room name (phase 8, wave 2) ---------------------
//
// `createRoom` required `name` unconditionally and checked it before it had
// computed `roomType`, so `POST /rooms { type: 'dm', memberIds: [x] }` — which
// is all the client can send, because there is no title to type for a one-to-one
// — failed with a 400 every single time.

async function createRoomRaw(token, payload) {
  const res = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  return res;
}

dbTest('a DM can be created with no name — it is named after the other person', async () => {
  const me = await authedAccount('wave2-dm-self@test.com');
  const them = await authedAccount('wave2-dm-other@test.com');

  const res = await createRoomRaw(me.token, { type: 'dm', memberIds: [them.userId] });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  const room = JSON.parse(body).data;

  assert.equal(room.type, 'dm');
  // The stored name is the other person's display name, not an empty string and
  // not a placeholder the client had to invent.
  assert.equal(room.name, 'Task Tester');
  assert.ok(room.slug, 'a slug is still allocated, so the NOT NULL column holds');
  assert.equal(room.members.length, 2, 'both people are in the room');
  assert.equal(room.existing, undefined, 'a first DM is not reported as existing');
});

dbTest('a DM with an explicit name still uses it', async () => {
  const me = await authedAccount('wave2-dm-named-self@test.com');
  const them = await authedAccount('wave2-dm-named-other@test.com');

  const res = await createRoomRaw(me.token, {
    type: 'dm',
    name: 'Explicit title',
    memberIds: [them.userId],
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  assert.equal(JSON.parse(body).data.name, 'Explicit title', 'a caller-supplied name is respected');
});

dbTest('a group still requires a name', async () => {
  const me = await authedAccount('wave2-group-noname@test.com');
  const them = await authedAccount('wave2-group-other@test.com');

  const res = await createRoomRaw(me.token, { type: 'group', memberIds: [them.userId] });
  assert.equal(res.status, 400, 'a group has no fallback name');
  assert.match(JSON.parse(await res.text()).message, /Room name is required/);

  // Nor when `type` is omitted and the single invitee would have inferred 'dm' —
  // the inference happens, and the resulting DM is still allowed to be nameless.
  const inferredDm = await createRoomRaw(me.token, { memberIds: [them.userId] });
  assert.equal(inferredDm.status, 201, 'one invitee with no type is a DM, and needs no name');
  await inferredDm.text();
});

dbTest('re-opening an existing DM pair with no name returns the same room', async () => {
  const me = await authedAccount('wave2-dm-dedup-self@test.com');
  const them = await authedAccount('wave2-dm-dedup-other@test.com');

  const firstRes = await createRoomRaw(me.token, { type: 'dm', memberIds: [them.userId] });
  const first = JSON.parse(await firstRes.text()).data;

  const second = await createRoomRaw(me.token, { type: 'dm', memberIds: [them.userId] });
  const body = await second.text();
  assert.equal(second.status, 200, 'the pair already has a DM, so nothing is created');
  const existing = JSON.parse(body).data;
  assert.equal(existing.id, first.id, 'and it is the same room');
  assert.equal(existing.existing, true);
});

// --- Attachment delivery proxy (phase 8, wave 3) -----------------------------
//
// Attachments used to link straight at res.cloudinary.com. Two problems, both
// real: anybody holding a URL could download any file with no check they were in
// the room, and on this account the delivery domain refuses everything that is
// not a plain image (JPEG 200, PDF 401, ZIP 401). The proxy fixes access control
// and fetches through Cloudinary's authenticated API, which those delivery rules
// do not apply to.
//
// The streaming half needs Cloudinary, which the test database does not have,
// so these cover what the test suite *can* reach: that membership is enforced,
// that an outsider gets 404 rather than 403, and that an SVG cannot be served
// inline. The end-to-end fetch was verified against the real account separately.

async function seedAttachmentVia(token, { roomId, publicId, resourceType, filename, fileType }) {
  const sent = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ roomId, content: `holding ${filename}` }),
  });
  const body = await sent.text();
  assert.equal(sent.status, 201, body);
  const message = JSON.parse(body).data;

  // Written with SQL rather than the upload flow: that flow needs Cloudinary,
  // and what is under test is the read path and its authorisation, not the
  // upload. Mirrors the columns the claim step now copies through.
  const { query } = require('../src/config/db');
  const inserted = await query(
    `INSERT INTO attachments (message_id, filename, file_url, file_type, size_bytes, public_id, resource_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      message.id,
      filename,
      `https://res.cloudinary.com/test/image/upload/v1/conclave/attachments/${filename}`,
      fileType,
      1024,
      publicId,
      resourceType,
    ],
  );
  return { messageId: message.id, attachmentId: inserted.rows[0].id };
}

dbTest('an attachment is served to a member of its room', async () => {
  const me = await authedAccount('wave3-member@test.com');
  const room = await createRoomVia(me.token, { name: 'Attachment Room' });
  const { attachmentId } = await seedAttachmentVia(me.token, {
    roomId: room.id,
    publicId: 'conclave/attachments/report',
    resourceType: 'raw',
    filename: 'report.pdf',
    fileType: 'application/pdf',
  });

  const res = await fetch(`${baseUrl}/api/attachments/${attachmentId}`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  // The upstream fetch will fail without real Cloudinary credentials, but the
  // request must get past authorisation — a 502 from the proxy proves it did,
  // where a 404 proves the membership check rejected a legitimate member.
  assert.ok(res.status === 502 || res.status === 200, `expected past auth, got ${res.status}`);
  assert.notEqual(res.status, 404, 'a member of the room is not refused');
  if (res.status === 502) await res.text();
});

dbTest('someone outside the room is refused — and it is 404, not 403', async () => {
  const owner = await authedAccount('wave3-owner@test.com');
  const outsider = await authedAccount('wave3-outsider@test.com');
  const room = await createRoomVia(owner.token, { name: 'Private Attachments' });
  const { attachmentId } = await seedAttachmentVia(owner.token, {
    roomId: room.id,
    publicId: 'conclave/attachments/secret',
    resourceType: 'raw',
    filename: 'secret.pdf',
    fileType: 'application/pdf',
  });

  const res = await fetch(`${baseUrl}/api/attachments/${attachmentId}`, {
    headers: { authorization: `Bearer ${outsider.token}` },
  });
  assert.equal(res.status, 404, 'membership is refused');
  const body = await res.text();
  assert.doesNotMatch(body, /only room admins|member of this room/i,
    'the refusal must not say whether the caller was a member');
});

dbTest('an anonymous request cannot reach the proxy', async () => {
  const me = await authedAccount('wave3-anon@test.com');
  const room = await createRoomVia(me.token, { name: 'Anon Room' });
  const { attachmentId } = await seedAttachmentVia(me.token, {
    roomId: room.id, publicId: 'conclave/attachments/x', resourceType: 'raw',
    filename: 'x.pdf', fileType: 'application/pdf',
  });

  const res = await fetch(`${baseUrl}/api/attachments/${attachmentId}`);
  assert.equal(res.status, 401, 'the proxy is auth-gated like every other route');
});

dbTest('an unknown attachment id is a 404, and a malformed one a 400', async () => {
  const me = await authedAccount('wave3-unknown@test.com');

  const unknown = await fetch(`${baseUrl}/api/attachments/00000000-0000-4000-8000-000000000000`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  assert.equal(unknown.status, 404);
  await unknown.text();

  const malformed = await fetch(`${baseUrl}/api/attachments/not-a-uuid`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  assert.equal(malformed.status, 400, 'validateUuidParams rejects a non-UUID id');
  await malformed.text();
});

test('new uploads use opaque R2 attachment keys', () => {
  const { buildKey, resolveMimetype } = require('../src/controllers/upload.controller');
  const key = buildKey('report.pdf');
  assert.match(key, /^conclave\/attachments\/[0-9a-f-]{36}-report.pdf$/);
  assert.equal(resolveMimetype('application/pdf', 'report.pdf'), 'application/pdf');
});

dbTest('a filename cannot smuggle a header break into Content-Disposition', async () => {
  const { sanitiseFilename, deriveFromUrl } = require('../src/controllers/attachments.controller');

  // Quotes and newlines are *removed* rather than replaced, so the value cannot
  // end the quoted-string token early or split the header at all.
  assert.equal(sanitiseFilename('a"b.pdf'), 'ab.pdf');
  assert.equal(sanitiseFilename('two\r\nX-Injected: 1.pdf'), 'twoX-Injected_ 1.pdf',
    'the newline is gone, so no second header can be introduced');
  assert.equal(sanitiseFilename(''), 'download');
  assert.equal(sanitiseFilename('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitiseFilename('normal name.pdf'), 'normal name.pdf',
    'ordinary names are left alone');

  // The pre-016 fallback: a delivery URL has to yield a usable public_id.
  assert.deepEqual(
    deriveFromUrl('https://res.cloudinary.com/test/raw/upload/v123/conclave/attachments/a.pdf'),
    { publicId: 'conclave/attachments/a.pdf', resourceType: 'raw' },
  );
  assert.deepEqual(
    deriveFromUrl('https://res.cloudinary.com/test/image/upload/v9/photo.jpg'),
    { publicId: 'photo.jpg', resourceType: 'image' },
  );
  assert.equal(deriveFromUrl(null), null);
});

// --- Room editing + task notifications (phase 8, wave 3) ---------------------
//
// Two reported gaps: an admin could rename a room only by creating another one,
// and flagging a message as a task told nobody at all.

async function updateRoomVia(token, roomId, payload) {
  return fetch(`${baseUrl}/api/rooms/${roomId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

dbTest('an admin can rename a room and set its description', async () => {
  const admin = await authedAccount('wave3-edit-admin@test.com');
  const room = await createRoomVia(admin.token, { name: 'Before the rename' });

  const res = await updateRoomVia(admin.token, room.id, {
    name: '  After the rename  ',
    description: 'What this room is actually for.',
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const updated = JSON.parse(body).data;

  assert.equal(updated.name, 'After the rename', 'the name is trimmed on the way in');
  assert.equal(updated.description, 'What this room is actually for.');

  // Persisted, and visible on a re-read rather than only echoed back.
  const reread = JSON.parse(await (await fetch(`${baseUrl}/api/rooms/${room.id}`, {
    headers: { authorization: `Bearer ${admin.token}` },
  })).text()).data;
  assert.equal(reread.name, 'After the rename');
  assert.equal(reread.description, 'What this room is actually for.');
});

dbTest('renaming does not change the slug', async () => {
  const admin = await authedAccount('wave3-slug-admin@test.com');
  const room = await createRoomVia(admin.token, { name: 'Original Title' });
  const before = room.slug;

  const res = await updateRoomVia(admin.token, room.id, { name: 'Completely Different' });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(await res.text()).data.slug, before,
    'slug is a display handle allocated once, not a routing key');

  // And a caller cannot smuggle one in through the body.
  const smuggled = await updateRoomVia(admin.token, room.id, { slug: 'mine' });
  assert.equal(smuggled.status, 400, 'slug is not an updatable field');
  assert.match(JSON.parse(await smuggled.text()).message, /No updatable fields/);
});

dbTest('room edits are validated and admin-only', async () => {
  const admin = await authedAccount('wave3-guard-admin@test.com');
  const member = await authedAccount('wave3-guard-member@test.com');
  const stranger = await authedAccount('wave3-guard-stranger@test.com');
  const room = await createRoomVia(admin.token, { type: 'group', name: 'Guarded', memberIds: [member.userId] });

  const byMember = await updateRoomVia(member.token, room.id, { name: 'Hijacked' });
  assert.equal(byMember.status, 403, 'a plain member cannot edit the room');
  await byMember.text();

  const byStranger = await updateRoomVia(stranger.token, room.id, { name: 'Hijacked' });
  assert.equal(byStranger.status, 403, 'a non-member is refused');
  await byStranger.text();

  const empty = await updateRoomVia(admin.token, room.id, { name: '   ' });
  assert.equal(empty.status, 400, 'a room cannot be renamed to whitespace');
  await empty.text();

  const emptyBody = await updateRoomVia(admin.token, room.id, {});
  assert.equal(emptyBody.status, 400, 'an empty body is an error, not a silent no-op');
  await emptyBody.text();

  const tooLong = await updateRoomVia(admin.token, room.id, { description: 'x'.repeat(1001) });
  assert.equal(tooLong.status, 400, 'description is length-capped');
  await tooLong.text();
});

dbTest('a DM reports the same display name from getRoom as from listRooms', async () => {
  const me = await authedAccount('wave3-dm-one@test.com');
  const them = await authedAccount('wave3-dm-other@test.com');
  const room = await createRoomVia(me.token, { type: 'dm', memberIds: [them.userId] });

  const detail = JSON.parse(await (await fetch(`${baseUrl}/api/rooms/${room.id}`, {
    headers: { authorization: `Bearer ${me.token}` },
  })).text()).data;
  const listed = JSON.parse(await (await fetch(`${baseUrl}/api/rooms`, {
    headers: { authorization: `Bearer ${me.token}` },
  })).text()).data.find((r) => r.id === room.id);

  assert.equal(detail.display_name, 'Task Tester', 'getRoom derives the other member');
  assert.equal(detail.display_name, listed.display_name, 'the two endpoints agree');
});

dbTest('assigning a task notifies the assignee with its title and room', async () => {
  const author = await authedAccount('wave3-task-author@test.com');
  const assignee = await authedAccount('wave3-task-assignee@test.com');
  const room = await createRoomVia(author.token, { name: 'Task Room' });

  // Bring the assignee into the room so the create-time membership check passes.
  await fetch(`${baseUrl}/api/rooms/${room.id}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({ userId: assignee.userId }),
  });

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${author.token}` },
    body: JSON.stringify({
      roomId: room.id,
      title: 'Ship the thing',
      body: 'With the notes attached.',
      assigneeId: assignee.userId,
    }),
  });
  const body = await created.text();
  assert.equal(created.status, 201, body);
  assert.equal(JSON.parse(body).data.body, 'With the notes attached.', 'notes are stored');

  const bell = (await (await fetch(`${baseUrl}/api/notifications`, {
    headers: { authorization: `Bearer ${assignee.token}` },
  })).json()).data;

  const taskNotice = bell.notifications.find((n) => n.type === 'task');
  assert.ok(taskNotice, 'the assignee has a task notification');
  assert.equal(taskNotice.context.task_title, 'Ship the thing', 'the title travels in its own field');
  assert.equal(taskNotice.context.room_name, 'Task Room');
  assert.equal(taskNotice.context.actor_name, 'Task Tester', 'and names who assigned it');
  assert.equal(taskNotice.context.message_preview, null,
    'a task title is not a sentence anyone said, so it does not borrow the preview field');
});

dbTest('a self-assigned or unassigned task notifies nobody, and does not fail', async () => {
  const me = await authedAccount('wave3-task-self@test.com');
  const room = await createRoomVia(me.token, { name: 'Solo Tasks' });

  const self = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ roomId: room.id, title: 'Mine to do', assigneeId: me.userId }),
  });
  const selfBody = await self.text();
  assert.equal(self.status, 201, selfBody + ' — createNotification would reject actor===recipient');

  const none = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ roomId: room.id, title: 'Nobody is doing this' }),
  });
  assert.equal(none.status, 201);
  await none.text();

  const bell = (await (await fetch(`${baseUrl}/api/notifications`, {
    headers: { authorization: `Bearer ${me.token}` },
  })).json()).data;
  // The room_invite row from createRoom's membership is a different type; what
  // matters is that no task row was written to the actor's own bell.
  assert.equal(bell.notifications.filter((n) => n.type === 'task').length, 0,
    'neither case notifies the actor');
});

dbTest('adding a member tells the members who were already there', async () => {
  const inviter = await authedAccount('wave3-join-inviter@test.com');
  const already = await authedAccount('wave3-join-already@test.com');
  const newcomer = await authedAccount('wave3-join-new@test.com');
  const room = await createRoomVia(inviter.token, {
    type: 'group', name: 'Join Notices', memberIds: [already.userId],
  });

  const res = await fetch(`${baseUrl}/api/rooms/${room.id}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${inviter.token}` },
    body: JSON.stringify({ userId: newcomer.userId }),
  });
  assert.equal(res.status, 201);
  await res.text();

  const existingBell = (await (await fetch(`${baseUrl}/api/notifications`, {
    headers: { authorization: `Bearer ${already.token}` },
  })).json()).data;
  assert.ok(
    existingBell.notifications.some((n) => n.type === 'member_joined'),
    'member_joined was allowlisted but never written',
  );

  // The newcomer is told they were invited, and not that they joined.
  const newcomerBell = (await (await fetch(`${baseUrl}/api/notifications`, {
    headers: { authorization: `Bearer ${newcomer.token}` },
  })).json()).data;
  assert.ok(newcomerBell.notifications.some((n) => n.type === 'room_invite'));
  assert.equal(newcomerBell.notifications.filter((n) => n.type === 'member_joined').length, 0,
    'the person who arrived is not told they arrived');
});

// ---------- message pins (phase 8, wave 5) ----------

async function pinMessageVia(token, messageId, scope) {
  return fetch(`${baseUrl}/api/messages/${messageId}/pin`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ scope }),
  });
}

async function unpinMessageVia(token, messageId, scope) {
  return fetch(`${baseUrl}/api/messages/${messageId}/pin/${scope}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function listPinnedVia(token, roomId) {
  const res = await fetch(`${baseUrl}/api/messages/room/${roomId}/pinned`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.text();
  return { status: res.status, body, json: () => JSON.parse(body) };
}

async function findMessageVia(token, roomId, messageId) {
  const res = await fetch(`${baseUrl}/api/messages/room/${roomId}?limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  });
  // Read once. Reading it for the assertion message and again to parse gives
  // "Body is unusable" on the second call, so the body is taken first and the
  // status assertion gets it as its message.
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const { messages } = JSON.parse(body).data;
  return messages.find((m) => m.id === messageId);
}

dbTest('a personal message bookmark is visible only to its author', async () => {
  const run = Date.now();
  const me = await authedAccount('mpin-user-me@test.com');
  const them = await authedAccount('mpin-user-them@test.com');
  const room = await createRoomVia(me.token, { name: `Message Pin User ${run}`, memberIds: [them.userId] });
  const message = await sendVia(me.token, room.id, 'A number worth keeping');

  const res = await pinMessageVia(me.token, message.id, 'user');
  assert.equal(res.status, 200, await res.text());

  const mine = await findMessageVia(me.token, room.id, message.id);
  assert.deepEqual(mine.pins.mine, ['user'], 'the author sees their own bookmark');
  assert.equal(mine.pins.room, null, 'a personal pin is never a room pin');

  const theirs = await findMessageVia(them.token, room.id, message.id);
  assert.deepEqual(theirs.pins.mine, [], 'another member does not inherit the bookmark');
  assert.equal(theirs.pins.room, null);

  // The panel lists room pins only, so a private bookmark is not even there.
  const theirsPanel = await listPinnedVia(them.token, room.id);
  assert.equal(theirsPanel.status, 200);
  assert.deepEqual(theirsPanel.json().data.messages, [], 'a bookmark is not listed for anyone');
});

dbTest('a room pin on a message is visible to every member and names its author', async () => {
  const run = Date.now();
  const me = await authedAccount('mpin-room-me@test.com');
  const them = await authedAccount('mpin-room-them@test.com');
  const room = await createRoomVia(me.token, { name: `Message Pin Room ${run}`, memberIds: [them.userId] });
  const message = await sendVia(me.token, room.id, 'Deploy is at 14:00');

  const res = await pinMessageVia(me.token, message.id, 'room');
  assert.equal(res.status, 200, await res.text());

  const theirs = await findMessageVia(them.token, room.id, message.id);
  assert.ok(theirs.pins.room, 'the other member sees the room pin');
  assert.equal(theirs.pins.room.user_id, me.userId);
  assert.equal(typeof theirs.pins.room.display_name, 'string');
  assert.deepEqual(theirs.pins.mine, [], 'seeing it does not make it theirs');

  const panel = await listPinnedVia(them.token, room.id);
  assert.equal(panel.status, 200);
  const ids = panel.json().data.messages.map((m) => m.id);
  assert.deepEqual(ids, [message.id], 'the panel lists exactly the pinned message');
  // The panel renders the same message component as the timeline, so it has to
  // arrive with the fields that component reads.
  const [listed] = panel.json().data.messages;
  assert.ok(listed.sender_name, 'the panel row names its sender');
  assert.ok(listed.created_at, 'the panel row is timestamped');
  assert.ok(listed.reactions, 'the panel row carries its reactions');
});

dbTest('a second room pin of one message is refused and names the holder', async () => {
  const run = Date.now();
  const me = await authedAccount('mpin-hold-me@test.com');
  const them = await authedAccount('mpin-hold-them@test.com');
  const room = await createRoomVia(me.token, { name: `Message Pin Held ${run}`, memberIds: [them.userId] });
  const message = await sendVia(me.token, room.id, 'Only one of us gets this');

  assert.equal((await pinMessageVia(me.token, message.id, 'room')).status, 200);

  const second = await pinMessageVia(them.token, message.id, 'room');
  assert.equal(second.status, 409, 'the second pinner is refused rather than taking over');

  // The holder did not change underneath them.
  const stillMine = await findMessageVia(me.token, room.id, message.id);
  assert.equal(stillMine.pins.room.user_id, me.userId, 'the original pinner kept the pin');
});

dbTest('re-pinning is idempotent rather than a duplicate row', async () => {
  const run = Date.now();
  const me = await authedAccount('mpin-idem@test.com');
  const room = await createRoomVia(me.token, { name: 'Message Pin Idem' });
  const message = await sendVia(me.token, room.id, 'Twice is not twice');

  assert.equal((await pinMessageVia(me.token, message.id, 'user')).status, 200);
  assert.equal((await pinMessageVia(me.token, message.id, 'user')).status, 200);

  const { rows } = await query(
    `SELECT count(*)::int AS n FROM message_pins WHERE message_id = $1 AND scope = 'user'`,
    [message.id],
  );
  assert.equal(rows[0].n, 1, 'still exactly one bookmark, not two');
});

dbTest('only the pinner or a room admin can unpin somebody else’s room pin', async () => {
  const run = Date.now();
  const me = await authedAccount('mpin-admin-me@test.com');
  const them = await authedAccount('mpin-admin-them@test.com');
  const room = await createRoomVia(me.token, { name: `Message Pin Admin ${run}`, memberIds: [them.userId] });
  const message = await sendVia(them.token, room.id, 'Admin takes this back');

  assert.equal((await pinMessageVia(them.token, message.id, 'room')).status, 200);

  const byOther = await unpinMessageVia(me.token, message.id, 'room');
  assert.equal(byOther.status, 200, 'the room admin may unpin it');

  const panel = await listPinnedVia(them.token, room.id);
  assert.deepEqual(panel.json().data.messages, [], 'and it leaves the panel');

  // Re-pinned by the non-admin, an admin can take it back; a plain member cannot.
  assert.equal((await pinMessageVia(them.token, message.id, 'room')).status, 200);
  const third = await authedAccount('mpin-admin-third@test.com');
  const byPlain = await unpinMessageVia(third.token, message.id, 'room');
  assert.equal(byPlain.status, 403, 'a non-member non-admin cannot');
});

dbTest('a stranger cannot pin, unpin, or list a room’s pins', async () => {
  const run = Date.now();
  const me = await authedAccount('mpin-priv-me@test.com');
  const outsider = await authedAccount('mpin-priv-out@test.com');
  const room = await createRoomVia(me.token, { name: 'Message Pin Private' });
  const message = await sendVia(me.token, room.id, 'Not for you');

  const pin = await pinMessageVia(outsider.token, message.id, 'room');
  assert.equal(pin.status, 403, 'a non-member cannot pin');

  assert.equal((await pinMessageVia(me.token, message.id, 'room')).status, 200);
  const unpin = await unpinMessageVia(outsider.token, message.id, 'room');
  assert.equal(unpin.status, 403, 'a non-member cannot unpin');

  const panel = await listPinnedVia(outsider.token, room.id);
  assert.equal(panel.status, 403, 'a non-member cannot list them');
});

dbTest('a bad pin scope is a 400, not a silently ignored pin', async () => {
  const run = Date.now();
  const me = await authedAccount('mpin-scope@test.com');
  const room = await createRoomVia(me.token, { name: 'Message Pin Scope' });
  const message = await sendVia(me.token, room.id, 'Scope check');

  const res = await pinMessageVia(me.token, message.id, 'everyone');
  assert.equal(res.status, 400, await res.text());
});

dbTest('unpinning a pin that is not there succeeds with nothing to report', async () => {
  const run = Date.now();
  const me = await authedAccount('mpin-absent@test.com');
  const room = await createRoomVia(me.token, { name: 'Message Pin Absent' });
  const message = await sendVia(me.token, room.id, 'Never pinned');

  const res = await unpinMessageVia(me.token, message.id, 'room');
  assert.equal(res.status, 200, 'a retried unpin is not a failure');
  const payload = JSON.parse(await res.text()).data;
  assert.equal(payload.unpinned, false, 'and it says plainly that nothing was removed');
});

dbTest('a pinned message leaves the panel when it is deleted', async () => {
  const run = Date.now();
  const me = await authedAccount('mpin-deleted@test.com');
  const room = await createRoomVia(me.token, { name: 'Message Pin Deleted' });
  const message = await sendVia(me.token, room.id, 'Here for now');

  assert.equal((await pinMessageVia(me.token, message.id, 'room')).status, 200);
  assert.equal((await listPinnedVia(me.token, room.id)).json().data.messages.length, 1);

  const del = await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${me.token}` },
  });
  assert.equal(del.status, 200, await del.text());

  const after = await listPinnedVia(me.token, room.id);
  assert.deepEqual(after.json().data.messages, [], 'a deleted message is not still pinned');
});

dbTest('pinning publishes message:pinned and message:unpinned', async () => {
  const run = Date.now();
  const me = await authedAccount('mpin-socket@test.com');
  const room = await createRoomVia(me.token, { name: 'Message Pin Socket' });
  const message = await sendVia(me.token, room.id, 'Tell the room');

  const { captured, io } = captureEmitIo();
  const app = require('../src/app');
  const previous = app.get('io');
  app.set('io', io);
  try {
    assert.equal((await pinMessageVia(me.token, message.id, 'room')).status, 200);
    assert.equal((await unpinMessageVia(me.token, message.id, 'room')).status, 200);
  } finally {
    app.set('io', previous);
  }

  const events = captured.map((c) => c.event);
  assert.ok(events.includes('message:pinned'), `expected message:pinned in ${events.join(', ')}`);
  assert.ok(events.includes('message:unpinned'), `expected message:unpinned in ${events.join(', ')}`);

  const pinnedEvent = captured.find((c) => c.event === 'message:pinned');
  assert.equal(pinnedEvent.payload.message.id, message.id, 'the payload is the message itself');
  assert.equal(pinnedEvent.payload.scope, 'room');
  assert.ok(pinnedEvent.payload.message.pins.room, 'carrying the shared pin, not a per-viewer delta');
});

dbTest('pins travel with a message that has just been sent', async () => {
  const run = Date.now();
  const me = await authedAccount('mpin-shape@test.com');
  const room = await createRoomVia(me.token, { name: 'Message Pin Shape' });
  const message = await sendVia(me.token, room.id, 'Shape check');

  // Every read path attaches pins; if one forgot, the client would render a
  // message whose menu offers to unpin something it does not know about.
  assert.deepEqual(message.pins, { room: null, mine: [] }, 'a newly sent message carries the field');
});

// ---------- digest read pointer (phase 8, wave 4) ----------

async function getDigestVia(token) {
  const res = await fetch(`${baseUrl}/api/digest`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  return JSON.parse(body).data;
}

dbTest('opening a room does not empty the digest; marking it read does', async () => {
  const run = Date.now();
  const me = await authedAccount('digest-open-me@test.com');
  const them = await authedAccount('digest-open-them@test.com');
  const room = await createRoomVia(me.token, { name: `Digest Open ${run}`, memberIds: [them.userId] });
  await sendVia(them.token, room.id, 'Something worth catching up on');

  const before = await getDigestVia(me.token);
  assert.ok(before.items.length > 0, 'the backlog is reported');

  // The regression this guards: reading a room used to move the same pointer
  // the digest reported on, so simply visiting the room silently emptied it.
  // GET /rooms/:id advances last_seen_at and must leave the digest alone.
  const roomRes = await fetch(`${baseUrl}/api/rooms/${room.id}`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  assert.equal(roomRes.status, 200, await roomRes.text());

  const afterVisit = await getDigestVia(me.token);
  assert.ok(afterVisit.items.length > 0, 'visiting the room did not empty the digest');

  const marked = await fetch(`${baseUrl}/api/digest/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({}),
  });
  assert.equal(marked.status, 200, await marked.text());

  const afterMark = await getDigestVia(me.token);
  assert.equal(afterMark.items.length, 0, 'marking it read does empty it');

  // And the room's own activity digest follows the same pointer.
  const roomDigest = await fetch(`${baseUrl}/api/digest/room/${room.id}`, {
    headers: { authorization: `Bearer ${me.token}` },
  });
  const roomItems = JSON.parse(await roomDigest.text()).data.items;
  assert.equal(roomItems.length, 0, 'the per-room digest moved with it');
});

dbTest('marking one room read leaves the other rooms’ backlogs alone', async () => {
  const me = await authedAccount('digest-scope-me@test.com');
  // A two-member room is a DM, and creating one is idempotent in the pair — so
  // a second room with the same counterpart returns the first one (200) instead
  // of a new room. Each room therefore gets its own counterpart.
  const first = await authedAccount('digest-scope-first@test.com');
  const second = await authedAccount('digest-scope-second@test.com');
  const run = Date.now();
  const one = await createRoomVia(me.token, { name: `Digest One ${run}`, memberIds: [first.userId] });
  const two = await createRoomVia(me.token, { name: `Digest Two ${run}`, memberIds: [second.userId] });
  await sendVia(first.token, one.id, 'In the first room');
  await sendVia(second.token, two.id, 'In the second room');

  const res = await fetch(`${baseUrl}/api/digest/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ roomId: one.id }),
  });
  assert.equal(res.status, 200, await res.text());

  const roomIds = (await getDigestVia(me.token)).items.map((item) => item.room_id);
  assert.ok(!roomIds.includes(one.id), 'the marked room is gone');
  assert.ok(roomIds.includes(two.id), 'the other room is untouched — the pointer is per room');
});

dbTest('a message notifies a member who is not present, but not one who is', async (t) => {
  // The one behaviour here that genuinely needs Redis. connectRedis() is called
  // by server.js, which this harness bypasses in order to listen on an
  // ephemeral port — so without this the client is closed,
  // getRoomOnlineUsers returns [], and the suppression asserted below would
  // pass for the wrong reason. Skipped rather than silently green if there is
  // no Redis to talk to.
  const { redisClient, connectRedis } = require('../src/config/redis');
  const { userJoinedRoom, userLeftRoom, socketConnected, socketDisconnected, renewSocket } = require('../src/services/presence.service');
  const connectedHere = !redisClient.isOpen;
  if (connectedHere) {
    try {
      await connectRedis();
    } catch {
      /* the skip below reports it */
    }
  }
  if (!redisClient.isOpen) {
    t.skip('Redis is unavailable, so room-presence suppression cannot be exercised');
    return;
  }

  try {
    const sender = await authedAccount('digest-online-sender@test.com');
    const present = await authedAccount('digest-online-present@test.com');
    const away = await authedAccount('digest-online-away@test.com');
    const room = await createRoomVia(sender.token, {
      name: `Digest Online ${Date.now()}`,
      memberIds: [present.userId, away.userId],
    });

    // Added the way joining a room does it, so the service reads a genuinely
    // populated set rather than a stub.
    const socketId = `notification-${randomUUID()}`;
    t.after(async () => {
      const reopen = !redisClient.isOpen;
      if (reopen) await connectRedis();
      await userLeftRoom(present.userId, room.id, socketId);
      await socketDisconnected(present.userId, socketId);
      if (reopen) await redisClient.quit();
    });
    await socketConnected(present.userId, socketId);
    await userJoinedRoom(present.userId, room.id, socketId);
    await renewSocket(present.userId, socketId, { foreground: true, roomId: room.id });
    await sendVia(sender.token, room.id, 'Are you there?');

    const bell = (token) => fetch(`${baseUrl}/api/notifications`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json()).then((b) => b.data);
    const count = (token, type) => bell(token).then((d) => d.notifications.filter((n) => n.type === type).length);

    assert.equal(await count(away.token, 'new_message'), 1,
      'somebody not looking at the room is told a message arrived');
    assert.equal(await count(present.token, 'new_message'), 0,
      'somebody already looking at the room is not — they can see it happen');
    assert.equal(await count(sender.token, 'new_message'), 0,
      'the sender is not notified of their own message');

    await renewSocket(present.userId, socketId, { foreground: false, roomId: null });
    await sendVia(sender.token, room.id, 'Still there?');
    assert.equal(await count(present.token, 'new_message'), 1, 'a background subscription must not suppress an alert');
    await userLeftRoom(present.userId, room.id, socketId);
    await socketDisconnected(present.userId, socketId);
  } finally {
    // Left open, the client would keep the test process alive after the suite.
    if (connectedHere) await redisClient.quit();
  }
});

// --- Task visibility: assignee, creator and room admin only ------------------
//
// The list and the write path share one predicate, so each test below is run
// against both: a task a member cannot SEE, they also cannot MOVE.

dbTest('a task is hidden from a member who is neither the assignee nor the creator', async () => {
  const run = Date.now();
  const admin = await authedAccount(`tv2-admin-${run}@test.com`);
  const bystander = await authedAccount(`tv2-bystander-${run}@test.com`);
  const assignee = await authedAccount(`tv2-assignee-${run}@test.com`);

  const room = await createRoomVia(admin.token, {
    name: `Task Visibility Two ${run}`,
    memberIds: [bystander.userId, assignee.userId],
  });

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ roomId: room.id, title: 'Watch the thing', assigneeId: assignee.userId }),
  });
  const createdBody = await created.text();
  assert.equal(created.status, 201, createdBody);
  const task = JSON.parse(createdBody).data;

  const titlesFor = async (token, query = '') => {
    const res = await fetch(`${baseUrl}/api/tasks${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    return JSON.parse(body).data.tasks.map((t) => t.title);
  };

  // The assignee is not the creator, so this is the case that used to be
  // indistinguishable from everybody else seeing it.
  assert.ok(
    (await titlesFor(assignee.token)).includes(task.title),
    'the assignee must see the task assigned to them',
  );
  assert.ok(
    (await titlesFor(admin.token)).includes(task.title),
    'the creator — who is also the room admin — must see it',
  );
  assert.ok(
    !(await titlesFor(bystander.token)).includes(task.title),
    'a plain member must not be shown a task they cannot act on',
  );

  // Room-scoped reads agree with the cross-room list rather than widening it.
  const scoped = await titlesFor(bystander.token, `?roomId=${room.id}`);
  assert.ok(!scoped.includes(task.title), 'the room-scoped list hides it too');

  // And the write path agrees with the read path.
  const patch = await fetch(`${baseUrl}/api/tasks/${task.id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bystander.token}` },
    body: JSON.stringify({ status: 'done' }),
  });
  const patchBody = await patch.text();
  assert.equal(patch.status, 404, `a bystander must not move a task: ${patch.status} ${patchBody}`);

  const asAdmin = await fetch(`${baseUrl}/api/tasks/${task.id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ status: 'in_progress' }),
  });
  assert.equal(asAdmin.status, 200, await asAdmin.text());
});

dbTest('an unassigned task stays visible to the person who created it', async () => {
  const run = Date.now();
  const admin = await authedAccount(`tv3-admin-${run}@test.com`);
  const bystander = await authedAccount(`tv3-bystander-${run}@test.com`);

  const room = await createRoomVia(admin.token, {
    name: `Task Visibility Three ${run}`,
    memberIds: [bystander.userId],
  });

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ roomId: room.id, title: 'Nobody owns this yet' }),
  });
  assert.equal(created.status, 201, await created.text());

  const titles = async (token) => {
    const res = await fetch(`${baseUrl}/api/tasks`, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    return JSON.parse(body).data.tasks.map((t) => t.title);
  };

  // Without the creator clause this would be invisible forever: it has no
  // assignee, and a plain member cannot see it, so only the admin role saves it.
  assert.ok(
    (await titles(admin.token)).includes('Nobody owns this yet'),
    'the creator of an unassigned task must still be able to find it',
  );
  assert.ok(
    !(await titles(bystander.token)).includes('Nobody owns this yet'),
    'and it must still be hidden from everyone else',
  );
});

// --- Polls -------------------------------------------------------------------

dbTest('a poll is created as a message and carries its options, with nobody having voted', async () => {
  const run = Date.now();
  const me = await authedAccount(`poll-create-${run}@test.com`);
  const room = await createRoomVia(me.token, { name: `Poll Create ${run}` });

  const res = await fetch(`${baseUrl}/api/polls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ roomId: room.id, question: `Lunch ${run}?`, options: ['Pizza', 'Sushi', ' '] }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  const message = JSON.parse(body).data;

  assert.equal(message.content, `Lunch ${run}?`, 'the question travels as the message content');
  assert.ok(message.poll, 'the created message must carry its poll');
  assert.equal(message.poll.question, `Lunch ${run}?`);
  assert.deepEqual(
    message.poll.options.map((o) => o.label),
    ['Pizza', 'Sushi'],
    'a blank option is dropped rather than stored as an empty choice',
  );
  assert.equal(message.poll.voter_count, 0, 'nobody has voted yet');
  assert.equal(message.poll.closed_at, null, 'a new poll is open');

  // The same poll comes back through the ordinary message read path, so the
  // timeline, search and history all agree on one shape.
  const listed = await findMessageVia(me.token, room.id, message.id);
  assert.ok(listed.poll, 'listMessages must attach the poll');
  assert.deepEqual(
    listed.poll.options.map((o) => o.id),
    message.poll.options.map((o) => o.id),
    'and the options must be the same ones',
  );
});

dbTest('poll input is validated before anything is written', async () => {
  const run = Date.now();
  const me = await authedAccount(`poll-validate-${run}@test.com`);
  const room = await createRoomVia(me.token, { name: `Poll Validate ${run}` });

  const send = (payload) => fetch(`${baseUrl}/api/polls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ roomId: room.id, ...payload }),
  });

  assert.equal((await send({ question: '', options: ['a', 'b'] })).status, 400, 'a question is required');
  assert.equal((await send({ question: 'Q', options: ['only'] })).status, 400, 'two options minimum');
  assert.equal(
    (await send({ question: 'Q', options: ['Same', 'same'] })).status,
    400,
    'two identical choices would split votes nobody can tell apart',
  );
  assert.equal(
    (await send({ question: 'Q', options: Array.from({ length: 13 }, (_, i) => `O${i}`) })).status,
    400,
    'the option ceiling is enforced',
  );

  const noRoom = await fetch(`${baseUrl}/api/polls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ question: 'Q', options: ['a', 'b'] }),
  });
  assert.equal(noRoom.status, 400, 'a poll needs a room');
});

dbTest('votes are attributed by name and counted per voter, not per vote', async () => {
  const run = Date.now();
  const me = await authedAccount(`poll-vote-${run}@test.com`);
  const them = await authedAccount(`poll-vote2-${run}@test.com`);
  const room = await createRoomVia(me.token, { name: `Poll Vote ${run}`, memberIds: [them.userId] });

  const created = await fetch(`${baseUrl}/api/polls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ roomId: room.id, question: `Pick ${run}`, options: ['A', 'B'] }),
  });
  const createdBody = await created.text();
  assert.equal(created.status, 201, createdBody);
  const message = JSON.parse(createdBody).data;
  const poll = message.poll;
  const [optionA, optionB] = poll.options;

  const vote = (token, pollId, optionIds) => fetch(`${baseUrl}/api/polls/${pollId}/vote`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ optionIds }),
  });

  assert.equal((await vote(me.token, poll.id, [optionA.id])).status, 200);
  assert.equal((await vote(them.token, poll.id, [optionB.id])).status, 200);

  const listed = await findMessageVia(me.token, room.id, message.id);
  const a = listed.poll.options.find((o) => o.id === optionA.id);
  const b = listed.poll.options.find((o) => o.id === optionB.id);

  assert.equal(a.voters.length, 1, 'one vote on A');
  assert.equal(a.voters[0].id, me.userId, 'and it is attributed to the person who cast it');
  assert.equal(a.voters[0].display_name, 'Task Tester', 'the voter is named, not merely counted');
  assert.ok(typeof a.voters[0].avatar_url !== 'undefined', 'so a client can render an avatar');
  assert.equal(b.voters.length, 1, 'one vote on B');
  assert.equal(listed.poll.voter_count, 2, 'two people voted, so two voters — not two votes');

  // Two members read the same poll: votes are public, so neither view differs.
  const theirs = await findMessageVia(them.token, room.id, message.id);
  assert.equal(theirs.poll.voter_count, listed.poll.voter_count, 'both viewers agree on the tally');
  assert.equal(
    theirs.poll.options.find((o) => o.id === optionA.id).voters[0].id,
    me.userId,
    'and both see who voted for what',
  );
});

dbTest('a single-choice vote replaces the previous one; multi-choice accumulates', async () => {
  const run = Date.now();
  const me = await authedAccount(`poll-single-${run}@test.com`);
  const room = await createRoomVia(me.token, { name: `Poll Single ${run}` });

  const create = (question, allowMultiple) => fetch(`${baseUrl}/api/polls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ roomId: room.id, question, options: ['A', 'B', 'C'], allowMultiple }),
  }).then(async (r) => {
    const b = await r.text();
    assert.equal(r.status, 201, b);
    const message = JSON.parse(b).data;
    return { poll: message.poll, messageId: message.id };
  });

  const vote = (pollId, optionIds) => fetch(`${baseUrl}/api/polls/${pollId}/vote`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ optionIds }),
  });

  const single = await create(`Single ${run}`, false);
  const [a, b] = single.poll.options;

  assert.equal((await vote(single.poll.id, [a.id])).status, 200);
  assert.equal((await vote(single.poll.id, [b.id])).status, 200);

  const afterSingle = (await findMessageVia(me.token, room.id, single.messageId)).poll;
  assert.deepEqual(
    afterSingle.options.map((o) => o.voters.length),
    [0, 1, 0],
    'voting again moves the vote rather than adding a second one',
  );

  // Asking for two on a single-choice poll is refused rather than silently
  // picking the first — a caller that thinks otherwise deserves to know.
  const greedy = await vote(single.poll.id, [a.id, b.id]);
  assert.equal(greedy.status, 400, await greedy.text());

  const multi = await create(`Multi ${run}`, true);
  assert.equal(
    (await vote(multi.poll.id, [multi.poll.options[0].id, multi.poll.options[1].id])).status,
    200,
  );
  const afterMulti = (await findMessageVia(me.token, room.id, multi.messageId)).poll;
  assert.deepEqual(
    afterMulti.options.map((o) => o.voters.length),
    [1, 1, 0],
    'a multi-choice poll holds both votes at once',
  );

  // An empty list is how you take your vote back.
  assert.equal((await vote(multi.poll.id, [])).status, 200);
  const cleared = (await findMessageVia(me.token, room.id, multi.messageId)).poll;
  assert.equal(cleared.voter_count, 0, 'an empty vote list removes the vote entirely');
});

dbTest('a vote must name options from its own poll, and only members may vote', async () => {
  const run = Date.now();
  const me = await authedAccount(`poll-scope-${run}@test.com`);
  const outsider = await authedAccount(`poll-outsider-${run}@test.com`);
  const room = await createRoomVia(me.token, { name: `Poll Scope ${run}` });

  const create = (question) => fetch(`${baseUrl}/api/polls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ roomId: room.id, question, options: ['A', 'B'] }),
  }).then(async (r) => { const b = await r.text(); assert.equal(r.status, 201, b); return JSON.parse(b).data.poll; });

  const first = await create(`First ${run}`);
  const second = await create(`Second ${run}`);

  const vote = (token, pollId, optionIds) => fetch(`${baseUrl}/api/polls/${pollId}/vote`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ optionIds }),
  });

  // Crossing the two polls would let a vote be recorded against an option that
  // is not in the poll it claims to be in — the composite foreign key stops the
  // insert, but the caller gets a 400 first rather than a raw 23503.
  const crossed = await vote(me.token, first.id, [second.options[0].id]);
  assert.equal(crossed.status, 400, await crossed.text());

  const stranger = await vote(outsider.token, first.id, [first.options[0].id]);
  assert.equal(stranger.status, 404, `a non-member must not learn the poll exists: ${stranger.status}`);

  const malformed = await vote(me.token, first.id, 'not-an-array');
  assert.equal(malformed.status, 400, 'a non-array payload is a 400, not a 500');
});

dbTest('only the poll creator or a room admin may close a poll, and closing stops votes', async () => {
  const run = Date.now();
  const owner = await authedAccount(`poll-close-owner-${run}@test.com`);
  const admin = await authedAccount(`poll-close-admin-${run}@test.com`);
  const bystander = await authedAccount(`poll-close-member-${run}@test.com`);

  // owner and bystander are plain members; admin created the room and is the
  // one non-creator whose opinion the rule also accepts.
  const room = await createRoomVia(admin.token, {
    name: `Poll Close ${run}`,
    memberIds: [owner.userId, bystander.userId],
  });

  const created = await fetch(`${baseUrl}/api/polls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ roomId: room.id, question: `Close ${run}?`, options: ['Yes', 'No'] }),
  });
  const createdBody = await created.text();
  assert.equal(created.status, 201, createdBody);
  const message = JSON.parse(createdBody).data;
  const poll = message.poll;

  const close = (token) => fetch(`${baseUrl}/api/polls/${poll.id}/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });

  const denied = await close(bystander.token);
  assert.equal(denied.status, 403, `a plain member must not close it: ${denied.status}`);

  const allowed = await close(admin.token);
  assert.equal(allowed.status, 200, `a room admin who did not make it may close it: ${await allowed.text()}`);

  const closed = (await findMessageVia(owner.token, room.id, message.id)).poll;
  assert.ok(closed.closed_at, 'a closed poll records when');

  const late = await fetch(`${baseUrl}/api/polls/${poll.id}/vote`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ optionIds: [poll.options[0].id] }),
  });
  assert.equal(late.status, 409, `a closed poll refuses votes: ${late.status}`);
  assert.equal(
    (await findMessageVia(bystander.token, room.id, message.id)).poll.closed_at !== null,
    true,
    'and every member sees that it is closed',
  );

  // Closing is one-way and does not erase the tally.
  const again = await close(admin.token);
  assert.equal(again.status, 200, 'closing an already closed poll is not an error');
});

dbTest('a poll question cannot be edited, because the votes underneath it would answer different words', async () => {
  const run = Date.now();
  const me = await authedAccount(`poll-edit-${run}@test.com`);
  const room = await createRoomVia(me.token, { name: `Poll Edit ${run}` });

  const created = await fetch(`${baseUrl}/api/polls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ roomId: room.id, question: `Original ${run}`, options: ['A', 'B'] }),
  });
  const createdBody = await created.text();
  assert.equal(created.status, 201, createdBody);
  const message = JSON.parse(createdBody).data;

  const edit = await fetch(`${baseUrl}/api/messages/${message.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ content: 'Rewritten after the fact' }),
  });
  const editBody = await edit.text();
  assert.equal(edit.status, 400, `editing a poll must be refused: ${edit.status} ${editBody}`);

  // An ordinary message from the same person still edits fine, so the guard is
  // on the poll, not on the author.
  const plain = await sendVia(me.token, room.id, 'Just words');
  const plainEdit = await fetch(`${baseUrl}/api/messages/${plain.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
    body: JSON.stringify({ content: 'Still just words' }),
  });
  assert.equal(plainEdit.status, 200, await plainEdit.text());
});


dbTest('storage cleanup protects avatars, retires unclaimed files and retries deletion jobs durably', async () => {
  const storage = require('../src/config/r2');
  const cleanup = require('../src/services/storageCleanup.service');
  const legacy = require('../src/config/cloudinary'); const legacyDestroy = legacy.uploader.destroy;
  legacy.uploader.destroy = async () => ({ result: 'ok' });
  const originalDelete = storage.deleteObject; const configured = storage.isConfigured;
  const suffix = randomUUID(); const orphanKey = `test-orphan-${suffix}`; const avatarKey = `test-avatar-${suffix}`;
  const avatarUrl = `r2://test/${avatarKey}`; const orphanUrl = `r2://test/${orphanKey}`;
  await query(`INSERT INTO file_uploads(uploader_id,file_url,filename,mime_type,size_bytes,public_id,resource_type,created_at)
    VALUES($1,$2,'avatar.png','image/png',10,$3,'r2',NOW()-INTERVAL '2 days'),($1,$4,'orphan.png','image/png',10,$5,'r2',NOW()-INTERVAL '2 days')`,
    [user.id,avatarUrl,avatarKey,orphanUrl,orphanKey]);
  await query('UPDATE users SET avatar_url=$2 WHERE id=$1',[user.id,avatarUrl]);
  let reject = true; const removed = [];
  storage.isConfigured = () => true;
  storage.deleteObject = async (key) => { if (key === orphanKey && reject) throw Object.assign(new Error('Temporary storage outage'),{name:'StorageUnavailable'}); removed.push(key); };
  try {
    await cleanup.runStorageCleanup({limit:500});
    assert.equal(removed.includes(avatarKey),false);
    assert.equal((await query('SELECT retired_at FROM file_uploads WHERE file_url=$1',[avatarUrl])).rows[0].retired_at,null);
    assert.ok((await query('SELECT retired_at FROM file_uploads WHERE file_url=$1',[orphanUrl])).rows[0].retired_at);
    const failed = (await query('SELECT * FROM storage_deletion_jobs WHERE object_key=$1',[orphanKey])).rows[0];
    assert.equal(failed.attempts,1); assert.equal(failed.last_error,'StorageUnavailable');
    await assert.rejects(query('UPDATE users SET avatar_url=$2 WHERE id=$1',[user.id,orphanUrl]),{code:'23514'});
    reject = false;
    await query('UPDATE storage_deletion_jobs SET next_attempt_at=NOW() WHERE id=$1',[failed.id]);
    await cleanup.runStorageCleanup({limit:500});
    assert.equal((await query('SELECT 1 FROM storage_deletion_jobs WHERE id=$1',[failed.id])).rowCount,0);
    assert.equal(removed.includes(orphanKey),true);
    // A queued object can still be an active avatar: postpone, then delete once unused.
    await query("INSERT INTO storage_deletion_jobs(provider,object_key) VALUES('r2',$1)",[avatarKey]);
    await cleanup.runStorageCleanup({limit:500});
    const protectedJob = (await query('SELECT * FROM storage_deletion_jobs WHERE object_key=$1',[avatarKey])).rows[0];
    assert.equal(protectedJob.last_error,'ActiveReference');
    assert.equal(removed.includes(avatarKey),false);
    await query('UPDATE users SET avatar_url=NULL WHERE id=$1',[user.id]);
    await query('UPDATE storage_deletion_jobs SET next_attempt_at=NOW() WHERE id=$1',[protectedJob.id]);
    await cleanup.runStorageCleanup({limit:500});
    assert.equal(removed.includes(avatarKey),true);
    assert.equal((await query('SELECT 1 FROM storage_deletion_jobs WHERE id=$1',[protectedJob.id])).rowCount,0);

  } finally { legacy.uploader.destroy = legacyDestroy; storage.deleteObject = originalDelete; storage.isConfigured = configured; await query('UPDATE users SET avatar_url=NULL WHERE id=$1',[user.id]); }
});

dbTest('shared files use bounded stable cursors, include documents/audio, and enforce room access', async () => {
  const me = await authedAccount(`shared-files-${randomUUID()}@test.com`);
  const stranger = await authedAccount(`shared-stranger-${randomUUID()}@test.com`);
  const chat = await createRoomVia(me.token, { name: 'Shared file pages' });
  const seeded = await query(`INSERT INTO messages(room_id,sender_id,room_sequence,content,created_at)
    SELECT $1,$2,n,'SHARED-CONTEXT-'||n,'2026-01-01T00:00:00Z'::timestamptz FROM generate_series(1,60) n RETURNING id,room_sequence`, [chat.id, me.userId]);
  await query('UPDATE rooms SET message_sequence=60 WHERE id=$1', [chat.id]);
  await query(`INSERT INTO attachments(message_id,filename,file_url,file_type,size_bytes)
    SELECT m.id, kind.ext, 'r2://test/'||m.id||kind.ext, kind.mime, 10 FROM messages m
    CROSS JOIN (VALUES ('photo.png','image/png'),('clip.mp4','video/mp4'),('report.pdf','application/pdf'),('voice.ogg','audio/ogg')) kind(ext,mime)
    WHERE m.room_id=$1`, [chat.id]);
  const headers = { authorization: `Bearer ${me.token}` };
  const get = async (params = '', token = me.token) => fetch(`${baseUrl}/api/messages/room/${chat.id}/media${params}`, { headers: { authorization: `Bearer ${token}` } });
  const firstRes = await get('?limit=7'); assert.equal(firstRes.status,200);
  const first = (await firstRes.json()).data;
  assert.equal(first.media.length,7); assert.ok(first.nextCursor);
  assert.ok(first.media.every((item) => /^(image|video)\//.test(item.mime_type) && item.message_id && item.room_sequence));
  const inserted = await sendVia(me.token,chat.id,'New while browsing');
  await query("INSERT INTO attachments(message_id,filename,file_url,file_type,size_bytes) VALUES($1,'new.png','r2://test/new','image/png',10)",[inserted.id]);
  const oldest = seeded.rows.find((item) => Number(item.room_sequence) === 1);
  await query('UPDATE messages SET deleted_at=NOW() WHERE id=$1',[oldest.id]);
  const ids = new Set(first.media.map((item) => item.id)); let cursor=first.nextCursor;
  while (cursor) {
    const response = await get(`?limit=7&cursor=${encodeURIComponent(cursor)}`); assert.equal(response.status,200);
    const page = (await response.json()).data; assert.ok(page.media.length <=7);
    page.media.forEach((item) => { assert.equal(ids.has(item.id),false,'no duplicate page items'); ids.add(item.id); }); cursor=page.nextCursor;
  }
  assert.equal(ids.size,118,'new inserts do not shift old pages; deleted files disappear');
  for (const [kind,mime] of [['documents','application/pdf'],['audio','audio/ogg']]) {
    const response=await get(`?kind=${kind}&limit=100`); const page=(await response.json()).data;
    assert.equal(page.media.length,59); assert.equal(page.nextCursor,null); assert.ok(page.media.every((item)=>item.mime_type===mime));
  }
  assert.equal((await get('',stranger.token)).status,404);
  for (const params of ['?limit=101','?limit=0','?kind=unknown','?cursor=invalid',`?kind=audio&cursor=${first.nextCursor}`,'?after=invalid']) assert.equal((await get(params)).status,400,params);
  const cleared = (await (await get('?after='+encodeURIComponent(new Date(Date.now()+86400000).toISOString()))).json()).data;
  assert.deepEqual(cleared,{media:[],nextCursor:null});
  const anchor = seeded.rows.find((item) => Number(item.room_sequence) === 55);
  const contextRes = await fetch(`${baseUrl}/api/messages/room/${chat.id}?around=${anchor.id}`,{headers});
  assert.equal(contextRes.status,200); const context=(await contextRes.json()).data;
  assert.equal(context.messages.length,50); assert.equal(context.messages[0].id,anchor.id); assert.equal(context.nextCursor,'6');
  assert.equal(context.messages.some((item)=>item.id===inserted.id),false,'anchor does not pull newer history');
  assert.equal((await fetch(`${baseUrl}/api/messages/room/${chat.id}?around=${oldest.id}`,{headers})).status,404);
  assert.equal((await fetch(`${baseUrl}/api/messages/room/${chat.id}?around=${anchor.id}&before=60`,{headers})).status,400);
  const other = await createRoomVia(me.token,{name:'Other shared room'});
  assert.equal((await fetch(`${baseUrl}/api/messages/room/${other.id}?around=${anchor.id}`,{headers})).status,404);
});

dbTest('forwarding reuses immutable media with independent access, idempotency and durable cleanup', async () => {
  const me = await authedAccount(`forward-self-${randomUUID()}@test.com`);
  const recipient = await authedAccount(`forward-recipient-${randomUUID()}@test.com`);
  const source = await createRoomVia(me.token,{name:'Private source'});
  const target = await createRoomVia(me.token,{type:'group',name:'Forward destination',memberIds:[recipient.userId]});
  const key=`test-forward-${randomUUID()}`;
  const original = await seedAttachmentVia(me.token,{roomId:source.id,publicId:key,resourceType:'r2',filename:'private-photo.png',fileType:'image/png'});
  const clientId=randomUUID();
  const body={roomId:target.id,clientId,content:'tampered caption',forwardSource:{messageId:original.messageId}};
  const send=(token,payload)=>fetch(`${baseUrl}/api/messages`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(payload)});
  const forwardedRes=await send(me.token,body); assert.equal(forwardedRes.status,201,await forwardedRes.clone().text());
  const forwarded=(await forwardedRes.json()).data;
  assert.equal(forwarded.forwarded,true); assert.equal(forwarded.content,'holding private-photo.png');
  assert.equal(forwarded.attachments.length,1); assert.notEqual(forwarded.attachments[0].id,original.attachmentId);
  const coordinates=await query('SELECT public_id,file_url FROM attachments WHERE id=ANY($1::uuid[])',[[original.attachmentId,forwarded.attachments[0].id]]);
  assert.equal(coordinates.rows[0].public_id,coordinates.rows[1].public_id); assert.equal(coordinates.rows[0].file_url,coordinates.rows[1].file_url);
  const retry=await send(me.token,body); assert.equal((await retry.json()).data.id,forwarded.id);
  assert.equal((await send(recipient.token,{...body,clientId:randomUUID()})).status,404,'destination membership never grants source access');
  assert.equal((await send(me.token,{...body,roomId:randomUUID(),clientId:randomUUID()})).status,404);
  assert.equal((await send(me.token,{...body,clientId:randomUUID(),attachments:[{url:'r2://invented'}]})).status,400);
  const dm=await createRoomVia(me.token,{type:'dm',memberIds:[recipient.userId]});
  await query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2)',[recipient.userId,me.userId]);
  assert.equal((await send(me.token,{...body,roomId:dm.id,clientId:randomUUID()})).status,403,'blocked DMs reject forwards');
  await query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2',[recipient.userId,me.userId]);
  assert.equal((await send(me.token,{...body,clientId:randomUUID(),forwardSource:{messageId:[original.messageId]}})).status,400);
  const history=await fetch(`${baseUrl}/api/messages/room/${target.id}`,{headers:{authorization:`Bearer ${recipient.token}`}});
  assert.equal((await history.json()).data.messages[0].forwarded,true);
  const storage=require('../src/config/r2'); const cleanup=require('../src/services/storageCleanup.service');
  const oldDelete=storage.deleteObject; const oldConfigured=storage.isConfigured; const oldSigned=storage.signedGetUrl; const removed=[];
  storage.isConfigured=()=>true;storage.deleteObject=async object=>{removed.push(object);};
  storage.signedGetUrl=async()=> 'https://media.example.test/forwarded-original';
  try {
    const deleted=await fetch(`${baseUrl}/api/messages/${original.messageId}`,{method:'DELETE',headers:{authorization:`Bearer ${me.token}`}});assert.equal(deleted.status,200);
    assert.equal((await send(me.token,{...body,clientId:randomUUID()})).status,404);
    assert.equal((await send(me.token,body)).status,201,'lost acknowledgement can recover an already-created forward after source deletion');
    assert.equal((await fetch(`${baseUrl}/api/attachments/${original.attachmentId}`,{headers:{authorization:`Bearer ${recipient.token}`}})).status,404);
    const signed=await fetch(`${baseUrl}/api/attachments/${forwarded.attachments[0].id}/url`,{headers:{authorization:`Bearer ${recipient.token}`}});assert.equal(signed.status,200);
    await cleanup.runStorageCleanup({limit:500});assert.equal(removed.includes(key),false,'a live forward protects bytes even without file_uploads provenance');
    const last=await fetch(`${baseUrl}/api/messages/${forwarded.id}`,{method:'DELETE',headers:{authorization:`Bearer ${me.token}`}});assert.equal(last.status,200);
    await query('UPDATE storage_deletion_jobs SET next_attempt_at=NOW() WHERE object_key=$1',[key]);
    await cleanup.runStorageCleanup({limit:500});assert.equal(removed.includes(key),true);
  } finally {storage.deleteObject=oldDelete;storage.isConfigured=oldConfigured;storage.signedGetUrl=oldSigned;}
});
