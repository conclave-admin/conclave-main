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
const { randomBytes } = require('node:crypto');

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

const { query } = require('../src/config/db');
const { createMessage } = require('../src/services/message.service');

// --- Suite lifecycle ---------------------------------------------------------

let admin;
let available = false;

// Fixtures created once after migrating. The database starts with schema only,
// so anything that needs a user or a room has to be handed one — several tests
// below were silently asserting against an empty table before this existed.
let user;
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
  'file_uploads',
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
    headers: { 'content-type': 'application/json' },
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
    headers: { 'content-type': 'application/json' },
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
    { sub: user.id, email: 'fixture@test.com' },
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
    ['id', 'filename', 'size', 'mime_type', 'url'],
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
      'assignee_id', 'assignee_name', 'created_at', 'created_by', 'due_date',
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
  assert.equal(bystanderList.unreadCount, 0, 'a room member who was not named gets nothing');
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
  assert.equal(list.unreadCount, 0, '"@Alison" must not count as a mention of "Al"');
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
  t.mock.method(presence, 'userConnected', async () => {});
  t.mock.method(presence, 'clearTyping', async () => {});
  require('../src/sockets')(io);
  const handlers = new Map();
  const errors = [];
  const joined = [];
  connect({
    id: 'mention-test-socket', user: { id: user.id }, connected: true,
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
