const cloudinary = require('../config/cloudinary');
const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');

// BACKEND_TASKS.md item C: which uploads we accept.
//
// Video is deliberately absent for now — the 25MB cap in upload.routes.js is a
// poor ceiling for it, so it is held back rather than half-supported.
//
// SVG is allowed. It is safe in the current client, which renders only the
// filename and never the URL, and it stays safe if previews are added later
// because <img src> does not execute script in an SVG. The exposure would be
// <object>, <embed>, or inlining the markup — avoid those. The real residual
// risk is a user hosting branded content on our Cloudinary quota.
//
// NOTE: this list is checked against req.file.mimetype, which is the
// client-declared multipart Content-Type, not a sniffed type. A client can
// declare image/png and upload anything. Cloudinary stores the real bytes, so
// nothing executable is served as an image, but the mime_type recorded here can
// be inaccurate. See the note in 010_add_file_uploads.sql.
const ALLOWED_MIME_TYPES = new Set([
  // images
  'image/svg+xml',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // documents
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  // office — word
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // office — sheet
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // office — presentation
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // archives
  'application/zip',
  'application/gzip',
  // audio
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/mp4',
]);

// Keep in step with the multer limit in upload.routes.js. Redundant on the happy
// path — multer rejects anything larger before we get here — but it means the
// bound does not live in exactly one place.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Push an in-memory buffer to Cloudinary and resolve with the stored asset.
 * Uses a stream rather than the buffer overload so the upload does not need a
 * second copy of the file in memory on top of multer's.
 *
 * Cloudinary infers the asset format from the filename extension, so `mimetype`
 * is only carried for the caller's own record.
 *
 * @returns {Promise<{ url: string, bytes: number, format: string, resourceType: string }>}
 */
function streamToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        // 'auto' lets Cloudinary classify the asset. Without it a .pdf would
        // have to be declared as an image or a raw file to be accepted.
        resource_type: 'auto',
        use_filename: true,
        filename_override: filename,
        // Folder them so the quota is easy to audit and clean up later.
        folder: 'conclave/attachments',
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          url: result.secure_url,
          bytes: result.bytes,
          format: result.format,
          resourceType: result.resource_type,
        });
      },
    );

    // Only the buffer goes to end() — the second argument is an *encoding*, so
    // passing metadata there throws ERR_UNKNOWN_ENCODING. Cloudinary infers the
    // format from the filename extension (see use_filename/filename_override).
    stream.on('error', reject);
    stream.end(buffer);
  });
}

/**
 * Accept a multipart upload, store it in Cloudinary, and record it so a later
 * message can attach it exactly once.
 *
 * Response shape is { filename, url, mime_type, size } — the same shape
 * listMessages returns. Note that clients must send only `url` back when
 * attaching; filename/mime_type/size are read from the record created here, not
 * from the request (see services/message.service.js).
 */
const uploadFile = asyncHandler(async (req, res) => {
  if (!cloudinary.isConfigured()) {
    throw new ApiError(503, 'File uploads are not configured on this server');
  }

  if (!req.file) {
    throw new ApiError(400, 'No file provided');
  }

  const { buffer, mimetype, originalname } = req.file;

  if (!ALLOWED_MIME_TYPES.has(mimetype)) {
    throw new ApiError(415, `Unsupported file type: ${mimetype}`);
  }

  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, 'File exceeds the 25MB limit');
  }

  const filename = (originalname || 'upload').trim() || 'upload';

  let asset;
  try {
    asset = await streamToCloudinary(buffer, filename);
  } catch (err) {
    // Cloudinary is an upstream dependency: a failure here is a 502, not our
    // bug, and its own error types are meaningless to the client. Logged because
    // otherwise a credential or quota problem is invisible — the client only
    // ever sees "temporarily unavailable".
    console.error('Cloudinary upload failed', err);
    throw new ApiError(502, 'File storage is temporarily unavailable');
  }

  const size = typeof asset.bytes === 'number' ? asset.bytes : buffer.length;

  // UNIQUE on file_url: if Cloudinary ever hands back a URL we already have, the
  // insert fails rather than creating a second unclaimed record for one asset.
  try {
    await query(
      `INSERT INTO file_uploads (uploader_id, file_url, filename, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, asset.url, filename, mimetype, size],
    );
  } catch (err) {
    if (err.code === '23505') {
      throw new ApiError(409, 'That file has already been uploaded');
    }
    // 42P01 is undefined_table — the 010 migration has not been run.
    if (err.code === '42P01') {
      throw new ApiError(503, 'File uploads are not available on this server');
    }
    throw err;
  }

  // Wrapped in the standard { success, data } envelope every other route uses.
  return ok(res, {
    filename,
    url: asset.url,
    mime_type: mimetype,
    size,
  }, 201);
});

module.exports = { uploadFile, ALLOWED_MIME_TYPES, MAX_UPLOAD_BYTES };