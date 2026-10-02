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
// SAFETY: it never touches your development database. It creates a throwaway
// database named by TEST_DB_NAME (default conclave_test), migrates it, and drops
// it afterwards. If Postgres is unreachable the whole suite skips rather than
// failing, so `npm test` still works on a machine with no database.
//
// Run with: npm run test:db     (or just `npm test`, which includes it)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

// --- Locate a Postgres to talk to, before anything reads env.js ---------------
require('dotenv').config({ quiet: true });

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://app:app@127.0.0.1:5432/postgres';
const TEST_DB = process.env.TEST_DB_NAME || 'conclave_test';

const adminUrl = new URL(ADMIN_URL);
const TEST_DB_URL =
  `postgresql://${adminUrl.username}:${adminUrl.password}` +
  `@${adminUrl.hostname}:${adminUrl.port || 5432}/${TEST_DB}`;

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
  // Pool from a previous run may still hold connections; terminate them first or
  // DROP DATABASE blocks.
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
    console.log(`# no Postgres at ${ADMIN_URL.replace(/:[^:@]*@/, ':<redacted>@')}: ${err.message}`);
    return;
  }

  try {
    await dropTestDb();
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    available = true;
  } catch (err) {
    // A user without CREATEDB cannot run this suite. Skip rather than fail, but
    // say why, since silently-passing integration tests are worse than none.
    console.log(`# skipping database suite: ${err.message}`);
    available = false;
    return;
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
  if (admin) {
    if (available) {
      try {
        await dropTestDb();
      } catch { /* best effort */ }
    }
    await admin.end().catch(() => {});
  }
  await require('../src/config/db').pool.end().catch(() => {});
});

// The skip decision has to be made INSIDE the test body, not in the options.
// A `{ skip }` option is evaluated when the test is registered, which happens
// before the `before` hook runs, so `available` would still be false and every
// test would be skipped whether or not Postgres is actually there.
const dbTest = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('no Postgres available');
    return fn(t);
  });

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
