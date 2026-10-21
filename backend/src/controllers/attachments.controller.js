const https = require('https');
const { pipeline } = require('stream');
const { parseByteRange } = require('../utils/byteRange');
const crypto = require('crypto');
const cloudinary = require('../config/cloudinary');
const r2 = require('../config/r2');
const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { fail, ok } = require('../utils/apiResponse');
const env = require('../config/env');

const DELIVERY_HOST = 'res.cloudinary.com';

/**
 * A signed delivery URL for one asset.
 *
 * Cloudinary's Admin API cannot be used to fetch the bytes: GET
 * /resources/<type>/upload/<id> returns the asset's *metadata* as JSON, and
 * verified against this account — it answers 200 with `{"asset_id":...}` and
 * never the file. `cloudinary.api.resource()` is the same endpoint and is worse
 * here, because in 2.11.0 it buffers the whole response and JSON.parses it.
 *
 * So the bytes come from the delivery host under a signature instead. That is
 * the standard mechanism and it is what makes delivery tamper-proof, but note
 * what this account currently does: signed and unsigned requests are refused
 * identically with 401 "deny or ACL failure" for every resource_type other than
 * `image` (a JPEG serves; a PDF and a ZIP do not). Signing is not the problem —
 * the account's delivery ACL is. `attachmentDeliveryBlocked()` below turns that
 * into a clear server error instead of a corrupt download.
 *
 * `api_secret` is used here and never leaves the server: the signature is what
 * lets a browser fetch the URL directly without holding the secret.
 */
function signedDeliveryUrl(publicId, resourceType) {
  // `publicId` is the normalised asset reference — public_id with the extension
  // always present — written by upload.controller from the two values
  // Cloudinary returns. That matters because Cloudinary signs
  // `public_id + "." + format`, while on this account one resource type puts the
  // extension inside public_id and the other leaves it in `format` with public_id
  // bare. Normalising once at write time means the signature here is always
  // simply sha1(publicId + secret), with no guesswork about which shape arrived.
  const signature = crypto
    .createHash('sha1')
    .update(`${publicId}${env.cloudinary.apiSecret}`)
    .digest('base64url')
    .slice(0, 8);

  return `https://${DELIVERY_HOST}/${env.cloudinary.cloudName}/${resourceType}/upload/s--${signature}--/${publicId}`;
}

function openUpstream(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        host: target.hostname,
        path: target.pathname,
        method: 'GET',
        headers: { 'User-Agent': 'conclave-attachments' },
      },
      (upstream) => {
        if (upstream.statusCode !== 200) {
          upstream.resume();
          const err = new Error(`upstream_${upstream.statusCode}`);
          err.status = upstream.statusCode;
          reject(err);
          return;
        }
        resolve(upstream);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Recover the Cloudinary coordinates for a row written before migration 016.
 *
 * A delivery URL has the shape
 *   https://res.cloudinary.com/<cloud>/<resource_type>/upload/v<version>/<public_id>
 * so the public_id is everything after the version segment. Parsing a URL to
 * recover two columns is a degradation, not a design — it is here so the four
 * attachments already in the dev database do not become unreachable the moment
 * this ships, and it is deliberately the fallback rather than the primary path.
 */
function deriveFromUrl(fileUrl) {
  if (!fileUrl) return null;
  const withoutOrigin = String(fileUrl).split('/upload/')[1];
  if (!withoutOrigin) return null;
  const segments = withoutOrigin.split('/');
  if (segments[0]?.startsWith('v')) segments.shift();
  const publicId = segments.join('/');
  if (!publicId) return null;

  const url = String(fileUrl);
  let resourceType = 'image';
  if (url.includes('/raw/upload/')) resourceType = 'raw';
  else if (url.includes('/video/upload/')) resourceType = 'video';
  return { publicId, resourceType };
}

/**
 * Serve one attachment.
 *
 * The client used to link straight at `res.cloudinary.com`, which means anyone
 * holding a URL could fetch any file in the workspace with no check that they
 * were even in the room. This route is the replacement: it resolves the
 * attachment to its room, confirms membership, and only then streams the bytes
 * from Cloudinary's authenticated API.
 *
 * A non-member gets 404 rather than 403. The attachment id is a UUID and an
 * outsider must not be able to learn it exists — the same reasoning as
 * getDecision, where an unknown decision and a forbidden one are deliberately
 * indistinguishable.
 *
 * @param {object} req - `req.params.attachmentId`
 */
const getAttachment = asyncHandler(async (req, res) => {
  const { attachmentId } = req.params;

  const result = await query(
    `SELECT a.id, a.filename, a.file_type, a.size_bytes, a.file_url, a.public_id, a.resource_type
       FROM attachments a
       INNER JOIN messages m ON m.id = a.message_id
       INNER JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
      WHERE a.id = $1 AND m.deleted_at IS NULL`,
    [attachmentId, req.user.id],
  );

  // Both "no such attachment" and "not yours" come back empty from that join, so
  // one 404 covers them.
  if (result.rows.length === 0) {
    throw new ApiError(404, 'Attachment not found');
  }

  const row = result.rows[0];
  if (row.resource_type === 'r2') return streamFromR2(row, req, res);

  const coords = row.public_id
    ? { publicId: row.public_id, resourceType: row.resource_type || 'image' }
    : deriveFromUrl(row.file_url);

  if (!coords) {
    throw new ApiError(502, 'Attachment storage is temporarily unavailable');
  }

  // No format is appended: this upload path already carries the extension
  // inside public_id.
  const url = signedDeliveryUrl(coords.publicId, coords.resourceType);

  let upstream;
  try {
    upstream = await openUpstream(url);
  } catch (err) {
    // 401 here means the account's delivery ACL refuses this resource type, not
    // that our signature is wrong — a bad signature is rejected differently.
    // It is worth its own log line because it is a Cloudinary *account setting*
    // to fix, not a code defect, and nothing else in the app will show it.
    if (err.status === 401) {
      console.error(
        `Cloudinary delivery denied for resource_type="${coords.resourceType}" ` +
          `(${attachmentId}). Signed and unsigned requests are refused identically, ` +
          'so this account has delivery ACLs that exclude non-image assets. ' +
          'Enable raw/non-image delivery in the Cloudinary console (Settings → Delivery).',
      );
      throw new ApiError(502, 'This file type cannot be served by the current storage settings');
    }
    console.error('Cloudinary fetch failed', { attachmentId, code: err.message });
    throw new ApiError(502, 'Attachment storage is temporarily unavailable');
  }

  /*
   * `attachment` rather than `inline`, and `nosniff` alongside it.
   *
   * image/svg+xml is an accepted upload type, and an SVG is script-capable.
   * Serving one inline from our own origin is a stored-XSS hole; the existing
   * note in upload.controller.js calls out <object>/<embed> as the exposure, and
   * this route would have been a third one. Always downloading means the
   * browser never interprets the bytes as a document, and nosniff stops it
   * re-interpreting a .png that is really HTML.
   */
  setDownloadHeaders(res, row);

  upstream.pipe(res);

  upstream.on('error', (err) => {
    console.error('Cloudinary stream error', { attachmentId, message: err.message });
    // Not `throw`: this is a plain event listener, so asyncHandler never sees
    // the exception and it becomes an uncaught error that takes the process
    // with it. Answer the client instead, and fall back to destroying the
    // socket if the headers are already gone.
    if (!res.headersSent) return fail(res, 'Attachment storage is temporarily unavailable', 502);
    res.destroy();
    return undefined;
  });
});

const getAttachmentUrl = asyncHandler(async (req, res) => {
  const { attachmentId } = req.params;
  const result = await query(
    `SELECT a.id, a.file_type, a.file_url, a.public_id, a.resource_type
       FROM attachments a
       INNER JOIN messages m ON m.id = a.message_id
       INNER JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
      WHERE a.id = $1 AND m.deleted_at IS NULL`,
    [attachmentId, req.user.id],
  );
  if (!result.rows.length) throw new ApiError(404, 'Attachment not found');
  const row = result.rows[0];
  if (row.resource_type === 'r2') {
    if (!r2.isConfigured()) throw new ApiError(503, 'File storage is not configured');
    const type = row.file_type || '';
    const streamable = type.startsWith('video/') || type.startsWith('audio/');
    let url;
    try {
      url = await r2.signedGetUrl(row.public_id, {
        expiresIn: 60,
        contentType: type,
        inline: streamable,
      });
    } catch (err) {
      console.error('R2 URL signing failed', { attachmentId, code: err.name });
      throw new ApiError(502, 'Attachment storage is temporarily unavailable');
    }
    return ok(res, { url, expiresAt: Math.floor(Date.now() / 1000) + 60 });
  }

  if (!cloudinary.isConfigured()) throw new ApiError(503, 'File storage is not configured');
  const coords = row.public_id ? { publicId: row.public_id, resourceType: row.resource_type || 'image' } : deriveFromUrl(row.file_url);
  if (!coords) throw new ApiError(502, 'Attachment storage is temporarily unavailable');
  const url = cloudinary.url(coords.publicId, { resource_type: coords.resourceType, secure: true });
  const token = cloudinary.utils.generate_auth_token({
    duration: 3600,
    url: new URL(url).pathname,
    key: env.cloudinary.apiSecret,
  });
  return ok(res, { url: `${url}?${token}`, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
});

const getAttachmentPreviewUrl = asyncHandler(async (req, res) => {
  const { attachmentId } = req.params;
  const result = await query(
    `SELECT a.file_type, a.public_id, a.resource_type
       FROM attachments a
       INNER JOIN messages m ON m.id = a.message_id
       INNER JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
      WHERE a.id = $1 AND m.deleted_at IS NULL`,
    [attachmentId, req.user.id],
  );
  if (!result.rows.length) throw new ApiError(404, 'Attachment not found');

  const row = result.rows[0];
  if (row.resource_type !== 'r2') return ok(res, { url: null, expiresAt: null });
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(row.file_type)) {
    return ok(res, { url: null, expiresAt: null });
  }

  const workerBase = env.r2.previewWorkerUrl;
  const secret = env.r2.previewSigningSecret;
  if (!workerBase || !secret || secret.length < 32) {
    throw new ApiError(503, 'Image previews are not configured');
  }

  let workerOrigin;
  try {
    workerOrigin = new URL(workerBase);
  } catch {
    throw new ApiError(503, 'Image previews are not configured');
  }
  if (workerOrigin.protocol !== 'https:') throw new ApiError(503, 'Image previews are not configured');

  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const canonical = `${row.public_id}\n${expiresAt}`;
  const signature = crypto.createHmac('sha256', secret).update(canonical).digest('base64url');
  const url = new URL(`/preview/${row.public_id}`, workerOrigin.origin);
  url.searchParams.set('exp', String(expiresAt));
  url.searchParams.set('sig', signature);
  return ok(res, { url: url.toString(), expiresAt });
});

function setDownloadHeaders(res, row) {
  const safe = sanitiseFilename(row.filename);
  // Keep a safe ASCII fallback and preserve the original UTF-8 filename for
  // clients that understand RFC 5987.
  const encoded = encodeURIComponent(String(row.filename || safe)).replace(/['()*]/g, escape);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`,
  );
  res.setHeader('Content-Type', row.file_type || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  if (row.size_bytes) res.setHeader('Content-Length', String(row.size_bytes));
}

async function streamFromR2(row, req, res) {
  if (!r2.isConfigured()) throw new ApiError(503, 'File storage is not configured');
  let object;
  try {
    const head = await r2.headObject(row.public_id);
    const size = head.ContentLength;
    res.setHeader('Accept-Ranges', 'bytes');
    if (head.ETag) res.setHeader('ETag', head.ETag);
    let range;
    try { range = parseByteRange(req.headers['if-range'] && req.headers['if-range'] !== head.ETag ? null : req.headers.range, size); }
    catch (error) { res.setHeader('Content-Range', `bytes */${size}`); throw error; }
    object = await r2.getObject(row.public_id, { range: range ? `bytes=${range.start}-${range.end}` : undefined, ifMatch: head.ETag });
    setDownloadHeaders(res, { ...row, size_bytes: range ? range.length : size });
    if (range) { res.status(206); res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`); }
    if (req.method === 'HEAD') { object.Body.destroy(); return res.end(); }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) throw new ApiError(404, 'Attachment not found');
    console.error('R2 fetch failed', { attachmentId: row.id, code: err.name });
    throw new ApiError(502, 'Attachment storage is temporarily unavailable');
  }
  // The browser may cancel while R2's HEAD/GET requests are still pending.
  if (res.destroyed) { object.Body.destroy(); return; }
  const disconnected = () => object.Body.destroy();
  res.on('close', disconnected);
  pipeline(object.Body, res, (error) => {
    res.off('close', disconnected);
    if (error && !res.destroyed) res.destroy(error);
  });
}

// A filename is echoed into a Content-Disposition header, which is a response
// header and cannot carry a newline. Quotes and separators go too: the value is
// quoted in the header, so an embedded quote would end the token early.
function sanitiseFilename(filename) {
  return String(filename || 'download')
    .replace(/[\r\n"]/g, '')
    .replace(/[^\w.\- ]/g, '_')
    .slice(0, 120) || 'download';
}

module.exports = { getAttachment, getAttachmentUrl, getAttachmentPreviewUrl, deriveFromUrl, sanitiseFilename, signedDeliveryUrl };
