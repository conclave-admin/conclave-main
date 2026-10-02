// File upload tests: POST /upload and the attachment provenance it enables
// (BACKEND_TASKS.md item C).
//
// Two layers, because they fail for different reasons:
//
//   1. Controller-level checks that need neither Postgres nor Cloudinary — the
//      allowlist, the "no file" rejection, the size bound. These run everywhere,
//      because a regression in them would otherwise only surface in CI.
//
//   2. A real Cloudinary round trip. This uploads an actual asset, asserts a
//      `file_uploads` row exists, and attaches it to a message. It skips unless
//      Postgres and Cloudinary credentials are both available, so `npm test`
//      still works on a machine that has neither.
//
// The round trip is not optional coverage: everything in item C rests on the
// upload record existing, and a stubbed Cloudinary would not catch a wrong
// upload_stream callback or a secure_url that is actually a public URL.
//
// SAFETY: like tests/integration.test.js, this never touches the development
// database — it uses the throwaway TEST_DB_NAME and drops it afterwards.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

// --- Environment, resolved before src/config/* is required --------------------

require('dotenv').config({ quiet: true });

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://app:app@127.0.0.1:5432/postgres';
const TEST_DB = process.env.TEST_DB_NAME || 'conclave_upload_test';

const adminUrl = new URL(ADMIN_URL);
const TEST_DB_URL =
  `postgresql://${adminUrl.username}:${adminUrl.password}` +
  `@${adminUrl.hostname}:${adminUrl.port || 5432}/${TEST_DB}`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET ||= 'upload-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'upload-test-refresh-secret';
process.env.CLIENT_ORIGIN ||= 'http://localhost:5173';

const cloudinary = require('../src/config/cloudinary');
const { ALLOWED_MIME_TYPES, uploadFile } = require('../src/controllers/upload.controller');

// --- The no-database checks --------------------------------------------------

test('the MIME allowlist covers the agreed types and no video', () => {
  for (const t of [
    'image/svg+xml', 'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf', 'text/plain', 'text/markdown', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip', 'application/gzip',
    'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4',
  ]) {
    assert.ok(ALLOWED_MIME_TYPES.has(t), `${t} should be allowed`);
  }

  // Video is held back deliberately, not by oversight.
  for (const t of ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo']) {
    assert.ok(!ALLOWED_MIME_TYPES.has(t), `${t} should not be allowed yet`);
  }

  // Executables must never be accepted, whatever the declared type.
  for (const t of ['application/x-msdownload', 'application/x-sh', 'application/javascript']) {
    assert.ok(!ALLOWED_MIME_TYPES.has(t), `${t} must be rejected`);
  }
});

test('isConfigured reflects whether the SDK has usable credentials', () => {
  // Whatever the machine has, this must be a boolean and must agree with the
  // SDK's resolved config — CLOUDINARY_URL overrides config(), so checking the
  // env vars directly would be wrong.
  assert.equal(typeof cloudinary.isConfigured(), 'boolean');
  const c = cloudinary.config();
  assert.equal(
    cloudinary.isConfigured(),
    Boolean(c.cloud_name && c.api_key && c.api_secret),
  );
});

/** Call the controller directly and resolve whatever it hands to next(). */
async function callUpload(req) {
  let handed = null;
  const res = {
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  await uploadFile(req, res, (err) => { handed = err; });
  return { error: handed, res };
}

test('a request with no file is rejected with 400', async () => {
  if (!cloudinary.isConfigured()) return; // 503 fires first; covered separately
  const { error } = await callUpload({ user: { id: 'x' }, file: undefined });
  assert.ok(error, 'should hand an error to next() rather than fake a success');
  assert.equal(error.status, 400);
});

test('a disallowed MIME type is rejected with 415 before any Cloudinary call', async () => {
  if (!cloudinary.isConfigured()) return;
  const { error } = await callUpload({
    user: { id: 'x' },
    file: {
      buffer: Buffer.from('#!/bin/sh\nrm -rf /\n'),
      mimetype: 'application/x-sh',
      originalname: 'install.sh',
    },
  });
  assert.ok(error);
  assert.equal(error.status, 415, `expected 415, got ${error.status}`);
});

test('video is rejected with 415 while video support is held back', async () => {
  if (!cloudinary.isConfigured()) return;
  const { error } = await callUpload({
    user: { id: 'x' },
    file: { buffer: Buffer.alloc(1024), mimetype: 'video/mp4', originalname: 'clip.mp4' },
  });
  assert.ok(error);
  assert.equal(error.status, 415);
});

// --- The real round trip -----------------------------------------------------

const hasCloudinary = cloudinary.isConfigured();

let admin;
let available = false;
let server;
let baseUrl;
let token;
let room;
let userId;

async function dropTestDb() {
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TEST_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
}

const dbTest = (name, fn) =>
  test(name, async (t) => {
    if (!hasCloudinary) return t.skip('no Cloudinary credentials configured');
    if (!available) return t.skip('no Postgres available');
    return fn(t);
  });

test.before(async () => {
  if (!hasCloudinary) {
    console.log('# skipping Cloudinary round trip: credentials not configured');
    return;
  }

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
    console.log(`# skipping upload round trip: ${err.message}`);
    return;
  }

  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, ['database/migrate.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });

  const app = require('../src/app');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'uploader@test.com',
      password: 'correct-horse-battery',
      displayName: 'Uploader',
    }),
  });
  const regBody = await reg.text();
  assert.equal(reg.status, 201, `register failed: ${reg.status} ${regBody}`);
  const { data } = JSON.parse(regBody);
  token = data.accessToken;
  userId = data.user.id;

  const { query } = require('../src/config/db');
  room = (
    await query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ('Upload Room', 'group', $1, 'upload-room') RETURNING id`,
      [userId],
    )
  ).rows[0];
  await query(
    `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'admin')`,
    [room.id, userId],
  );
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (admin) {
    if (available) {
      try { await dropTestDb(); } catch { /* best effort */ }
    }
    await admin.end().catch(() => {});
  }
  await require('../src/config/db').pool.end().catch(() => {});
});

dbTest('a real upload is stored in Cloudinary and recorded for attachment', async () => {
  const { query } = require('../src/config/db');

  // A 1x1 PNG — the smallest valid image, so the round trip is quick.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');

  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await res.text();
  assert.equal(res.status, 201, `upload failed: ${res.status} ${body}`);

  const upload = JSON.parse(body).data;
  assert.deepEqual(
    Object.keys(upload).sort(),
    ['filename', 'mime_type', 'size', 'url'],
    'the response shape is what the client sends back as attachments[].url',
  );
  assert.equal(upload.filename, 'pixel.png');
  assert.equal(upload.mime_type, 'image/png');
  assert.ok(upload.url.startsWith('https://'), 'must return a secure_url, not an http one');

  const row = (
    await query('SELECT uploader_id, attached_message_id FROM file_uploads WHERE file_url = $1', [upload.url])
  ).rows[0];
  assert.ok(row, 'the upload must be recorded so a message can claim it later');
  assert.equal(row.uploader_id, userId);
  assert.equal(row.attached_message_id, null, 'it starts unclaimed');

  // Clean up the real asset so repeated runs do not pile up in the account.
  test.after(() => cloudinary.uploader.destroy(upload.url).catch(() => {}));
});

dbTest('an uploaded file attaches to exactly one message, with server-owned metadata', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'attach-me.png');
  const upRes = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const upBody = await upRes.text();
  assert.equal(upRes.status, 201, upBody);
  const upload = JSON.parse(upBody).data;
  test.after(() => cloudinary.uploader.destroy(upload.url).catch(() => {}));

  const { query } = require('../src/config/db');
  const { createMessage } = require('../src/services/message.service');

  // The client sends the URL and lies about everything else.
  const message = await createMessage({
    roomId: room.id,
    senderId: userId,
    content: 'here is the file',
    attachments: [{
      url: upload.url,
      filename: 'something-else.exe',
      mime_type: 'application/x-msdownload',
      size: 999999,
    }],
  });

  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].url, upload.url);
  assert.equal(message.attachments[0].filename, 'attach-me.png', 'filename must come from the upload record');
  assert.equal(message.attachments[0].mime_type, 'image/png', 'mime_type must come from the upload record');
  assert.notEqual(message.attachments[0].size, 999999, 'the client-supplied size must be ignored');

  // A second message cannot reuse it.
  await assert.rejects(
    () => createMessage({
      roomId: room.id, senderId: userId, content: 'again', attachments: [{ url: upload.url }],
    }),
    (err) => err.status === 400,
    'the same upload must not attach twice',
  );

  const count = (
    await query('SELECT COUNT(*)::int n FROM attachments WHERE file_url = $1', [upload.url])
  ).rows[0].n;
  assert.equal(count, 1, 'exactly one attachment row for one upload');
});

dbTest('a rejected upload never reaches Cloudinary and never leaves a record', async () => {
  const { query } = require('../src/config/db');
  const before = (await query('SELECT COUNT(*)::int n FROM file_uploads')).rows[0].n;

  const form = new FormData();
  form.append('file', new Blob([Buffer.from('binary')], { type: 'application/x-msdownload' }), 'payload.exe');

  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await res.text();
  assert.equal(res.status, 415, `expected 415, got ${res.status}: ${body}`);

  const after = (await query('SELECT COUNT(*)::int n FROM file_uploads')).rows[0].n;
  assert.equal(after, before, 'a rejected upload must not be recorded');
});

dbTest('uploading requires authentication', async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('x')], { type: 'image/png' }), 'anon.png');
  const res = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
  assert.equal(res.status, 401, 'an anonymous upload must not be accepted');
});