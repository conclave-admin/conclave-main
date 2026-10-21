const { pool } = require('../config/db');
const r2 = require('../config/r2');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { buildKey, resolveMimetype, limitFor } = require('../controllers/upload.controller');
const { validateMediaMetadata } = require('../utils/mediaMetadata');
const { verifyFileSignature } = require('../utils/fileSignature');
const PART_SIZE = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const missing = (error) => error.name === 'NotFound' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;

async function membership(client, roomId, userId) {
  if (!(await client.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId])).rowCount) throw new ApiError(404, 'Conversation not found');
}
function descriptor(row) {
  return { url: `r2://${r2.bucket}/${row.object_key}`, filename: row.filename, mime_type: row.mime_type,
    size: row.size_bytes, ...row.metadata };
}
async function inSession(userId, sessionId, work) {
  if (!UUID.test(sessionId || '')) throw new ApiError(400, 'Invalid upload session');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM media_upload_sessions WHERE id = $1 AND uploader_id = $2 FOR UPDATE', [sessionId, userId]);
    if (!rows.length) throw new ApiError(404, 'Upload session not found');
    await membership(client, rows[0].room_id, userId);
    if (rows[0].status !== 'completed' && (rows[0].status !== 'uploading' || new Date(rows[0].expires_at) <= new Date())) throw new ApiError(410, 'Upload session expired or cancelled. Retry to start a new upload.');
    const result = await work(client, rows[0]);
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
function validateRequest(body) {
  const { filename, mime_type, size, clientId, roomId, metadata } = body;
  if (!UUID.test(clientId || '') || !UUID.test(roomId || '')) throw new ApiError(400, 'A valid clientId and roomId are required');
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 255) throw new ApiError(400, 'A filename up to 255 characters is required');
  const type = resolveMimetype(mime_type, filename);
  if (!type) throw new ApiError(415, 'Unsupported file type');
  if (!Number.isInteger(size) || size <= 0 || size > limitFor(type)) throw new ApiError(413, 'File size exceeds its upload limit');
  return { filename, mime_type: type, size, clientId, roomId, metadata: validateMediaMetadata(metadata, type) };
}
async function createSession(userId, body) {
  if (!env.r2.directUploads || !r2.isConfigured()) throw new ApiError(503, 'Direct uploads are not configured');
  const input = validateRequest(body);
  const client = await pool.connect(); let created;
  try {
    await client.query('BEGIN');
    await membership(client, input.roomId, userId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`upload:${userId}:${input.clientId}`]);
    const { rows } = await client.query('SELECT * FROM media_upload_sessions WHERE uploader_id = $1 AND client_id = $2 FOR UPDATE', [userId, input.clientId]);
    if (rows.length) {
      const row = rows[0];
      if (row.room_id !== input.roomId || row.filename !== input.filename || row.size_bytes !== input.size || row.mime_type !== input.mime_type) throw new ApiError(409, 'This clientId already identifies another file');
      const usable = row.status === 'completed' && (await client.query('SELECT 1 FROM file_uploads WHERE file_url=$1 AND retired_at IS NULL', [descriptor(row).url])).rowCount;
      if (usable || (!body.restart && row.status === 'uploading' && new Date(row.expires_at) > new Date())) {
        await client.query('COMMIT'); return sessionView(row);
      }
      // A fresh attempt uses a fresh object key; old signed part URLs cannot alter it.
      await client.query(`INSERT INTO storage_deletion_jobs(provider, object_key, upload_id) VALUES ('r2',$1,$2),('r2',$1,'') ON CONFLICT DO NOTHING`, [row.object_key, row.upload_id]);
      await client.query('DELETE FROM media_upload_sessions WHERE id = $1', [row.id]);
    }
    const active = await client.query("SELECT COUNT(*)::int n FROM media_upload_sessions WHERE uploader_id = $1 AND status = 'uploading' AND expires_at > NOW()", [userId]);
    if (active.rows[0].n >= 50) throw new ApiError(429, 'Too many pending uploads. Cancel old uploads or wait for them to expire.');
    const key = buildKey(input.filename);
    const uploadId = await r2.createMultipart(key, input.mime_type);
    created = { key, uploadId };
    const result = await client.query(`INSERT INTO media_upload_sessions(uploader_id, room_id, client_id, object_key, upload_id, filename, mime_type, size_bytes, metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [userId, input.roomId, input.clientId, key, uploadId, input.filename, input.mime_type, input.size, input.metadata]);
    await client.query('COMMIT'); created = null; return sessionView(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if (created) await r2.abortMultipart(created.key, created.uploadId).catch(() => {});
    throw error;
  } finally { client.release(); }
}
async function sessionView(row) {
  if (row.status === 'completed') return { id: row.id, attachment: descriptor(row), parts: [], partSize: PART_SIZE };
  let parts = [];
  try { parts = await r2.listParts(row.object_key, row.upload_id); }
  catch (error) {
    if (error.name !== 'NoSuchUpload') throw error;
    try { await r2.headObject(row.object_key); } catch (headError) { if (missing(headError)) throw new ApiError(410, 'Upload session expired. Retry to start again.'); throw headError; }
    return { id: row.id, partSize: PART_SIZE, readyToFinalize: true, parts: [] };
  }
  return { id: row.id, partSize: PART_SIZE, expiresAt: row.expires_at,
    parts: parts.map((part) => ({ partNumber: part.PartNumber, size: part.Size, etag: part.ETag })) };
}
function getSession(userId, id) { return inSession(userId, id, async (client, row) => {
  if (row.status === 'completed' && !(await client.query('SELECT 1 FROM file_uploads WHERE file_url=$1 AND retired_at IS NULL',[descriptor(row).url])).rowCount) throw new ApiError(410,'Upload expired. Retry to upload again.');
  return sessionView(row);
}); }
function signPart(userId, id, partNumber) {
  return inSession(userId, id, async (_, row) => {
    if (row.status !== 'uploading') throw new ApiError(409, 'Upload already completed');
    const count = Math.ceil(row.size_bytes / PART_SIZE);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) throw new ApiError(400, 'Invalid part number');
    const size = Math.min(PART_SIZE, row.size_bytes - (partNumber - 1) * PART_SIZE);
    return { url: await r2.signedPartUrl(row.object_key, row.upload_id, partNumber, size), size, expiresIn: 300 };
  });
}
function validateParts(parts, size) {
  const count = Math.ceil(size / PART_SIZE);
  if (parts.length !== count || parts.some((part, index) => part.PartNumber !== index + 1 || !part.ETag || part.Size !== Math.min(PART_SIZE, size - index * PART_SIZE))) throw new ApiError(400, 'Upload parts are incomplete or have the wrong size');
}
async function finalizeSession(userId, id) {
  let rejection;
  const result = await inSession(userId, id, async (client, row) => {
    if (row.status === 'completed') {
      const record = await client.query('SELECT 1 FROM file_uploads WHERE file_url = $1 AND retired_at IS NULL', [descriptor(row).url]);
      if (!record.rowCount) throw new ApiError(410, 'This upload is no longer available');
      return descriptor(row);
    }
    let head;
    try { head = await r2.headObject(row.object_key); } catch (error) { if (!missing(error)) throw error; }
    if (!head) {
      const parts = await r2.listParts(row.object_key, row.upload_id); validateParts(parts, row.size_bytes);
      await r2.completeMultipart(row.object_key, row.upload_id, parts);
      head = await r2.headObject(row.object_key);
    }
    try {
      if (head.ContentLength !== row.size_bytes) throw new ApiError(413, 'The uploaded size does not match the authorized file');
      const object = await r2.getObject(row.object_key, { range: 'bytes=0-65535' });
      const chunks = []; for await (const chunk of object.Body) chunks.push(chunk);
      let detected;
      if (row.mime_type === 'application/zip' || row.mime_type.includes('openxmlformats')) {
        const stream = await r2.getObject(row.object_key);
        try { const { fileTypeFromStream } = await import('file-type'); detected = await fileTypeFromStream(stream.Body); }
        finally { stream.Body.destroy(); }
      }
      await verifyFileSignature(Buffer.concat(chunks), row.mime_type, detected);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      rejection = error;
      await client.query("UPDATE media_upload_sessions SET status = 'rejected' WHERE id = $1", [id]);
      await client.query("INSERT INTO storage_deletion_jobs(provider, object_key) VALUES ('r2',$1) ON CONFLICT DO NOTHING", [row.object_key]);
      return null;
    }
    const attachment = descriptor(row);
    await client.query(`INSERT INTO file_uploads(uploader_id, file_url, filename, mime_type, size_bytes, public_id, resource_type, width, height, preview_url, duration)
      VALUES($1,$2,$3,$4,$5,$6,'r2',$7,$8,$9,$10) ON CONFLICT(file_url) DO NOTHING`,
    [userId, attachment.url, row.filename, row.mime_type, row.size_bytes, row.object_key, row.metadata.width, row.metadata.height, row.metadata.preview_url, row.metadata.duration]);
    await client.query("UPDATE media_upload_sessions SET status = 'completed' WHERE id = $1", [id]);
    return attachment;
  });
  if (rejection) throw rejection;
  return result;
}
async function cancelSession(userId, id) {
  return inSession(userId, id, async (client, row) => {
    const file = await client.query('SELECT attached_message_id FROM file_uploads WHERE file_url = $1 FOR UPDATE', [descriptor(row).url]);
    if (file.rows[0]?.attached_message_id) throw new ApiError(409, 'This file is already attached to a message');
    await client.query("UPDATE media_upload_sessions SET status = 'cancelled' WHERE id = $1", [id]);
    await client.query('UPDATE file_uploads SET retired_at = NOW() WHERE file_url = $1', [descriptor(row).url]);
    await client.query(`INSERT INTO storage_deletion_jobs(provider, object_key, upload_id) VALUES ('r2',$1,$2),('r2',$1,'') ON CONFLICT DO NOTHING`, [row.object_key, row.upload_id]);
    return { cancelled: true };
  });
}
module.exports = { PART_SIZE, validateRequest, validateParts, createSession, getSession, signPart, finalizeSession, cancelSession };
