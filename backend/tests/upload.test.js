// File upload tests: POST /upload and the attachment provenance it enables
// (BACKEND_TASKS.md item C).
//
// Two layers, because they fail for different reasons:
//
//   1. Controller-level checks that need neither Postgres nor R2 — the
//      allowlist, the "no file" rejection, the size bound. These run everywhere,
//      because a regression in them would otherwise only surface in CI.
//
//   2. A real R2 round trip. This uploads an actual asset, asserts a
//      `file_uploads` row exists, and attaches it to a message. It skips unless
//      Postgres and R2 credentials are both available, so `npm test`
//      still works on a machine that has neither.
//
// The round trip is not optional coverage: everything in item C rests on the
// upload record existing, and a stubbed S3 client would not catch a bad R2
// endpoint, credentials, or request signing configuration.
//
// Uses a uniquely named disposable database, dropped only after this run
// creates it. DATABASE_URL must point to a test PostgreSQL server.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { randomBytes } = require('node:crypto');

// --- Environment, resolved before src/config/* is required --------------------

require('dotenv').config({ quiet: true });

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://app:app@127.0.0.1:5432/postgres';
// A unique name per suite/run: never drop a pre-existing database.
const TEST_DB = `conclave_upload_test_${randomBytes(12).toString('hex')}`;

const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${TEST_DB}`;
const TEST_DB_URL = testUrl.toString();

process.env.DATABASE_URL = TEST_DB_URL;
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.R2_DIRECT_UPLOADS_ENABLED = 'true';
process.env.JWT_ACCESS_SECRET ||= 'upload-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'upload-test-refresh-secret';
process.env.CLIENT_ORIGIN ||= 'http://localhost:5173';
process.env.R2_PREVIEW_WORKER_URL ||= 'https://media-preview.example.workers.dev';
process.env.R2_PREVIEW_SIGNING_SECRET ||= 'upload-test-preview-signing-secret-long-enough';

const r2 = require('../src/config/r2');
const {
  ALLOWED_MIME_TYPES,
  EXTENSION_MIME_TYPES,
  resolveMimetype,
  buildKey,
  uploadFile,
} = require('../src/controllers/upload.controller');

// --- The no-database checks --------------------------------------------------

test('the MIME allowlist covers the agreed types', () => {
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

  for (const t of ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp']) {
    assert.ok(ALLOWED_MIME_TYPES.has(t), `${t} should be allowed`);
  }
  // Formats browsers cannot play stay refused.
  for (const t of ['video/x-msvideo', 'video/x-matroska']) {
    assert.ok(!ALLOWED_MIME_TYPES.has(t), `${t} should not be allowed`);
  }

  // Executables must never be accepted, whatever the declared type.
  for (const t of ['application/x-msdownload', 'application/x-sh', 'application/javascript']) {
    assert.ok(!ALLOWED_MIME_TYPES.has(t), `${t} must be rejected`);
  }
});

// --- The extension fallback -------------------------------------------------
//
// Windows files .md as application/octet-stream, and some clients send an
// empty Content-Type. Without the fallback both were a hard 415 on a file the
// allowlist was perfectly happy to hold — which is what this repairs.

test('an allowlisted declared type is used as-is, whatever the extension says', () => {
  assert.equal(resolveMimetype('image/png', 'notes.md'), 'image/png');
  assert.equal(resolveMimetype('TEXT/MARKDOWN', 'readme.txt'), 'text/markdown');
  assert.equal(resolveMimetype('application/pdf', 'invoice'), 'application/pdf');
});

test('a missing or meaningless type falls back to the file extension', () => {
  assert.equal(resolveMimetype('application/octet-stream', 'notes.md'), 'text/markdown');
  assert.equal(resolveMimetype('', 'notes.md'), 'text/markdown');
  assert.equal(resolveMimetype('application/octet-stream', 'PHOTO.PNG'), 'image/png');
  assert.equal(resolveMimetype('application/x-unknown-content-type', 'a.tar.zip'), 'application/zip');
  assert.equal(resolveMimetype(undefined, 'song.m4a'), 'audio/mp4');
});

test('the fallback never yields a type outside the allowlist', () => {
  for (const [ext, mime] of EXTENSION_MIME_TYPES) {
    assert.ok(ALLOWED_MIME_TYPES.has(mime), `.${ext} maps to ${mime}, which is not allowed`);
    assert.equal(resolveMimetype('application/octet-stream', `f.${ext}`), mime);
  }
});

test('a declared type we understand but do not allow is still refused', () => {
  // Falling back to the extension here would be a way around the allowlist
  // rather than a repair of a missing value.
  assert.equal(resolveMimetype('video/x-msvideo', 'clip.avi'), null);
  assert.equal(resolveMimetype('text/html', 'page.html'), null);
  assert.equal(resolveMimetype('application/x-sh', 'install.sh'), null);
});

test('executable, markup and unplayable-video extensions are not a back door', () => {
  for (const name of ['page.html', 'run.exe', 'setup.sh', 'clip.avi', 'clip.mkv']) {
    assert.equal(resolveMimetype('application/octet-stream', name), null, `${name} must stay refused`);
  }
});

test('video extensions resolve when the declared type is meaningless', () => {
  assert.equal(resolveMimetype('application/octet-stream', 'clip.mov'), 'video/quicktime');
  assert.equal(resolveMimetype('', 'clip.mp4'), 'video/mp4');
  assert.equal(resolveMimetype('application/octet-stream', 'clip.webm'), 'video/webm');
});

test('an unrecognised extension with a meaningless type is refused', () => {
  assert.equal(resolveMimetype('application/octet-stream', 'archive.7z'), null);
  assert.equal(resolveMimetype('application/octet-stream', 'noextension'), null);
  assert.equal(resolveMimetype('application/octet-stream', 'trailing.'), null);
});

test('R2 configuration has a boolean readiness check and upload keys are unique and opaque', () => {
  assert.equal(typeof r2.isConfigured(), 'boolean');
  const keyA = buildKey('final report (1).pdf');
  const keyB = buildKey('final report (1).pdf');
  assert.match(keyA, /^conclave\/attachments\/[0-9a-f-]{36}-final_report__1_.pdf$/);
  assert.notEqual(keyA, keyB);
});

/** Call the controller directly and resolve whatever it hands to next(). */
async function callUpload(req, { configured = true } = {}) {
  let handed = null;
  const originalConfigured = r2.isConfigured;
  r2.isConfigured = () => configured;
  const res = {
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  try {
    await uploadFile(req, res, (err) => { handed = err; });
    return { error: handed, res };
  } finally {
    r2.isConfigured = originalConfigured;
  }
}

test('a request with no file is rejected with 400', async () => {
  const { error } = await callUpload({ user: { id: 'x' }, file: undefined });
  assert.ok(error, 'should hand an error to next() rather than fake a success');
  assert.equal(error.status, 400);
});

test('uploads fail with 503 when R2 is not configured', async () => {
  const { error } = await callUpload({ user: { id: 'x' }, file: undefined }, { configured: false });
  assert.ok(error);
  assert.equal(error.status, 503);
});

test('a disallowed MIME type is rejected with 415 before any R2 call', async () => {
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

test('an unsupported video type is rejected with 415', async () => {
  const { error } = await callUpload({
    user: { id: 'x' },
    file: { buffer: Buffer.alloc(1024), mimetype: 'video/x-msvideo', originalname: 'clip.avi' },
  });
  assert.ok(error);
  assert.equal(error.status, 415);
});

test('a video over 50MB is rejected with 413', async () => {
  const { error } = await callUpload({
    user: { id: 'x' },
    file: { buffer: Buffer.alloc(51 * 1024 * 1024), mimetype: 'video/mp4', originalname: 'big.mp4' },
  });
  assert.ok(error);
  assert.equal(error.status, 413);
});

test('a .md filed as octet-stream now clears the type check', async () => {
  // Oversized on purpose: it stops at the size bound, which sits *after* the
  // type check, so the assertion proves the 415 no longer fires without
  // pushing a file into R2.
  const { error } = await callUpload({
    user: { id: 'x' },
    file: {
      buffer: Buffer.alloc(26 * 1024 * 1024),
      mimetype: 'application/octet-stream',
      originalname: 'notes.md',
    },
  });
  assert.ok(error, 'the size bound should still stop it');
  assert.equal(error.status, 413, `expected 413, got ${error.status}: ${error.message}`);
});

// --- The real round trip -----------------------------------------------------

const hasR2 = r2.isConfigured();

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
    if (!hasR2) return t.skip('R2 credentials are not configured');
    if (!available) return t.skip('no Postgres available');
    return fn(t);
  });

test.before(async () => {
  if (!hasR2) {
    console.log('# skipping R2 round trip: credentials are not configured');
    return;
  }

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
  await require('../src/config/db').pool.end();
  if (admin) {
    if (available) {
      try { await dropTestDb(); } catch { /* best effort */ }
    }
    await admin.end().catch(() => {});
  }
});

dbTest('a real upload is stored in R2 and recorded for attachment', async () => {
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
    ['duration', 'filename', 'height', 'mime_type', 'preview_url', 'size', 'url', 'width'],
    'the response shape is what the client sends back as attachments[].url',
  );
  assert.equal(upload.filename, 'pixel.png');
  assert.equal(upload.mime_type, 'image/png');
  assert.ok(upload.url.startsWith(`r2://${r2.bucket}/conclave/attachments/`), 'the client receives an opaque R2 key');

  const row = (
    await query('SELECT uploader_id, attached_message_id, public_id, resource_type FROM file_uploads WHERE file_url = $1', [upload.url])
  ).rows[0];
  assert.ok(row, 'the upload must be recorded so a message can claim it later');
  assert.equal(row.uploader_id, userId);
  assert.equal(row.attached_message_id, null, 'it starts unclaimed');
  assert.equal(row.resource_type, 'r2');
  assert.equal(upload.url, `r2://${r2.bucket}/${row.public_id}`);

  const profile = await fetch(`${baseUrl}/api/users/me`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ avatar_url: upload.url }),
  });
  assert.equal(profile.status, 200, 'the account can save its R2 avatar key');
  const avatarResponse = await fetch(`${baseUrl}/api/users/avatar-url?url=${encodeURIComponent(upload.url)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(avatarResponse.status, 200, 'the active profile avatar can be resolved for the client');
  const avatar = (await avatarResponse.json()).data;
  assert.ok(avatar.url.includes('X-Amz-Signature='));
  const image = await fetch(avatar.url);
  assert.equal(image.status, 200, 'the signed URL is browser-fetchable');
  assert.equal(image.headers.get('content-type'), 'image/png');

  // Remove this uniquely named test object after the suite.
  test.after(() => r2.deleteObject(row.public_id).catch(() => {}));
});

dbTest('an uploaded file attaches to exactly one message, with server-owned metadata', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'attach-me.png');
  const metadata = { width: 1, height: 1, preview_url: 'data:image/jpeg;base64,/9j/2Q==' };
  form.append('mediaMetadata', JSON.stringify(metadata));
  const upRes = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const upBody = await upRes.text();
  assert.equal(upRes.status, 201, upBody);
  const upload = JSON.parse(upBody).data;
  const key = upload.url.slice(`r2://${r2.bucket}/`.length);
  test.after(() => r2.deleteObject(key).catch(() => {}));

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
  for (const field of ['width', 'height', 'preview_url']) assert.equal(message.attachments[0][field], metadata[field]);
  const history = await fetch(`${baseUrl}/api/messages/room/${room.id}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(history.status, 200);
  const saved = (await history.json()).data.messages.find((row) => row.id === message.id);
  assert.equal(saved.attachments[0].preview_url, metadata.preview_url);
  assert.equal(saved.attachments[0].width, 1);

  const attachmentId = message.attachments[0].id;
  assert.ok(attachmentId, 'the claimed attachment has a server id');
  const download = await fetch(`${baseUrl}/api/attachments/${attachmentId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(download.status, 200, 'the membership-checked proxy streams R2 bytes');
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);

  const urlResponse = await fetch(`${baseUrl}/api/attachments/${attachmentId}/url`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(urlResponse.status, 200, 'R2 attachments can also get a short-lived media URL');
  const signed = (await urlResponse.json()).data;
  assert.ok(signed.url.includes('X-Amz-Signature='));
  assert.ok(signed.expiresAt > Math.floor(Date.now() / 1000));

  const previewResponse = await fetch(`${baseUrl}/api/attachments/${attachmentId}/preview-url`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(previewResponse.status, 200, 'the room member can request a private preview URL');
  const preview = (await previewResponse.json()).data;
  const previewUrl = new URL(preview.url);
  assert.equal(previewUrl.origin, new URL(process.env.R2_PREVIEW_WORKER_URL).origin);
  assert.match(previewUrl.pathname, /^\/preview\/conclave\/attachments\//);
  assert.ok(preview.expiresAt > Math.floor(Date.now() / 1000));
  assert.equal(previewUrl.searchParams.get('exp'), String(preview.expiresAt));
  assert.equal(
    previewUrl.searchParams.get('sig'),
    require('crypto').createHmac('sha256', process.env.R2_PREVIEW_SIGNING_SECRET)
      .update(`${key}\n${preview.expiresAt}`).digest('base64url'),
    'the signed preview token must match the Worker verification format',
  );

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

dbTest('a rejected upload never reaches R2 and never leaves a record', async () => {
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


dbTest('private multipart uploads resume, finalize once, support Range and queue deletion durably', async () => {
  const { randomUUID } = require('crypto');
  const service = require('../src/services/multipartUpload.service');
  const { query } = require('../src/config/db');
  const size = service.PART_SIZE + 32;
  const bytes = Buffer.alloc(size, 32); bytes.write('%PDF-1.4\n');
  const input = { roomId: room.id, clientId: randomUUID(), filename: 'resumable.pdf', mime_type: 'application/pdf', size };
  const session = await service.createSession(userId, input);
  const row = (await query('SELECT * FROM media_upload_sessions WHERE id = $1', [session.id])).rows[0];
  test.after(() => r2.deleteObject(row.object_key).catch(() => {}));
  test.after(() => r2.abortMultipart(row.object_key,row.upload_id).catch(() => {}));
  await assert.rejects(service.getSession(randomUUID(), session.id), { status:404 });
  const first = await service.signPart(userId, session.id,1);
  assert.equal((await fetch(first.url,{ method:'PUT', body:bytes.subarray(0,service.PART_SIZE) })).status,200);
  const resumed = await service.getSession(userId,session.id);
  assert.equal(resumed.parts.length,1); assert.equal(resumed.parts[0].size,service.PART_SIZE);
  assert.equal((await service.createSession(userId,input)).id,session.id);
  const second = await service.signPart(userId,session.id,2);
  assert.equal((await fetch(second.url,{ method:'PUT', body:bytes.subarray(service.PART_SIZE) })).status,200);
  const attachment = await service.finalizeSession(userId,session.id);
  assert.deepEqual(await service.finalizeSession(userId,session.id),attachment);
  const { createMessage, deleteMessage } = require('../src/services/message.service');
  const message = await createMessage({ roomId:room.id,senderId:userId,clientId:input.clientId,content:'multipart document',attachments:[attachment] });
  const id = message.attachments[0].id;
  const response = await fetch(`${baseUrl}/api/attachments/${id}`,{ headers:{ authorization:`Bearer ${token}`,range:'bytes=5-18' } });
  assert.equal(response.status,206); assert.equal(response.headers.get('content-range'),`bytes 5-18/${size}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(5,19));
  const invalid = await fetch(`${baseUrl}/api/attachments/${id}`,{ headers:{ authorization:`Bearer ${token}`,range:`bytes=${size}-` } });
  assert.equal(invalid.status,416);
  await deleteMessage({ messageId:message.id,userId });
  assert.ok((await query('SELECT 1 FROM storage_deletion_jobs WHERE object_key=$1',[row.object_key])).rowCount);
  const deleted = await fetch(`${baseUrl}/api/attachments/${id}`,{ headers:{ authorization:`Bearer ${token}`,range:'bytes=0-4' } });
  assert.equal(deleted.status,404);
});

dbTest('multipart finalization rejects a false MIME type before creating a claimable upload', async () => {
  const { randomUUID } = require('crypto');
  const service = require('../src/services/multipartUpload.service');
  const { query } = require('../src/config/db');
  const bytes = Buffer.from('<html>This is not a PNG image.</html>');
  const session = await service.createSession(userId,{roomId:room.id,clientId:randomUUID(),filename:'spoof.png',mime_type:'image/png',size:bytes.length});
  const row = (await query('SELECT * FROM media_upload_sessions WHERE id=$1',[session.id])).rows[0];
  test.after(() => r2.deleteObject(row.object_key).catch(() => {}));
  const authorization = await service.signPart(userId,session.id,1);
  assert.equal((await fetch(authorization.url,{method:'PUT',body:bytes})).status,200);
  await assert.rejects(service.finalizeSession(userId,session.id),{status:415});
  assert.equal((await query('SELECT status FROM media_upload_sessions WHERE id=$1',[session.id])).rows[0].status,'rejected');
  assert.equal((await query('SELECT 1 FROM file_uploads WHERE public_id=$1',[row.object_key])).rowCount,0);
  assert.ok((await query('SELECT 1 FROM storage_deletion_jobs WHERE object_key=$1',[row.object_key])).rowCount);
});
