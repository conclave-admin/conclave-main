const crypto = require("crypto");
const { verifyFileSignature } = require("../utils/fileSignature");
const { validateMediaMetadata } = require("../utils/mediaMetadata");
const r2 = require("../config/r2");
const { query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { ok } = require("../utils/apiResponse");

// BACKEND_TASKS.md item C: which uploads we accept.
//
// Video is accepted up to 50MB (MAX_VIDEO_BYTES), against 25MB for everything
// else. New uploads go to R2; Cloudinary remains available for legacy files.
//
// SVG is allowed. The client renders it only through <img src>, which does not
// execute script in an SVG. The exposure would be <object>, <embed>, or
// inlining the markup — avoid those. The real residual risk is a user hosting
// branded content in our R2 bucket.
//
// NOTE: this list is checked against req.file.mimetype, which is the
// client-declared multipart Content-Type, not a sniffed type. A client can
// declare image/png and upload anything. R2 stores the real bytes, so
// nothing executable is served as an image, but the mime_type recorded here can
// be inaccurate. See the note in 010_add_file_uploads.sql.
const ALLOWED_MIME_TYPES = new Set([
  // images
  "image/svg+xml",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  // video
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/3gpp",
  // documents
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  // office — word
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  // office — sheet
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  // office — presentation
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // archives
  "application/zip",
  "application/gzip",
  // audio
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/mp4",
]);

// The fallback for a declared type that means nothing. Several clients send
// one of these instead of a real type: Windows has no idea what Markdown is
// and files .md as application/octet-stream, and some send an empty
// Content-Type for a text file. Rejecting those made ordinary files
// unattachable, which is a worse outcome than trusting the extension — and an
// extension is no less trustworthy than the declared type, which the note above
// already records is not sniffed either way.
const UNKNOWN_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-unknown-content-type",
  "application/binary",
]);

// Only extensions for types already on the allowlist are mapped, so this can
// never widen it. `.m4a` and `.weba` are the audio files audio/mp4 and
// audio/webm were meant for; `.mp4` and `.webm` are video.
const EXTENSION_MIME_TYPES = new Map([
  ["svg", "image/svg+xml"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["mp4", "video/mp4"],
  ["m4v", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
  ["3gp", "video/3gpp"],
  ["pdf", "application/pdf"],
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
  ["csv", "text/csv"],
  ["doc", "application/msword"],
  [
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["ppt", "application/vnd.ms-powerpoint"],
  [
    "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ["zip", "application/zip"],
  ["gz", "application/gzip"],
  ["mp3", "audio/mpeg"],
  ["ogg", "audio/ogg"],
  ["wav", "audio/wav"],
  ["weba", "audio/webm"],
  ["m4a", "audio/mp4"],
]);

/**
 * The mime type to record for an upload, or null if it must be refused.
 *
 * An allowlisted declared type always wins. Otherwise the type is consulted
 * only when it is one of the meaningless ones above — a declared type we
 * understand but do not allow (HTML, an executable) is still refused,
 * because falling back to the extension there would be a way around the
 * allowlist rather than a repair of a missing value.
 *
 * @param {string} mimetype - as declared by the client
 * @param {string} filename - the original name, for the extension fallback
 * @returns {string|null}
 */
function resolveMimetype(mimetype, filename) {
  const declared =
    typeof mimetype === "string" ? mimetype.trim().toLowerCase() : "";
  if (declared === "application/vnd.conclave.encrypted") return declared;
  if (ALLOWED_MIME_TYPES.has(declared)) return declared;
  if (!UNKNOWN_MIME_TYPES.has(declared)) return null;

  const name = typeof filename === "string" ? filename : "";
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return EXTENSION_MIME_TYPES.get(name.slice(dot + 1).toLowerCase()) || null;
}

// Keep the controller's per-type bounds alongside multer's 50MB outer bound.
// Multer admits video-sized uploads, and this controller applies the smaller
// limit to every non-video file.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

function limitFor(mimetype) {
  return mimetype === "application/vnd.conclave.encrypted" ||
    mimetype.startsWith("video/")
    ? MAX_VIDEO_BYTES
    : MAX_UPLOAD_BYTES;
}

function buildKey(filename) {
  const safe =
    String(filename)
      .replace(/[^\w.\-]/g, "_")
      .slice(-80) || "upload";
  return `conclave/attachments/${crypto.randomUUID()}-${safe}`;
}

/**
 * Accept a multipart upload, store it in R2, and record it so a later
 * message can attach it exactly once.
 *
 * Response shape is { filename, url, mime_type, size } — the same shape
 * listMessages returns. Note that clients must send only `url` back when
 * attaching; filename/mime_type/size are read from the record created here, not
 * from the request (see services/message.service.js).
 */
const uploadFile = asyncHandler(async (req, res) => {
  if (!r2.isConfigured()) {
    throw new ApiError(503, "File uploads are not configured on this server");
  }

  if (!req.file) {
    throw new ApiError(400, "No file provided");
  }

  const { buffer, mimetype: declaredType, originalname } = req.file;

  const filename =
    declaredType === "application/vnd.conclave.encrypted"
      ? "encrypted.bin"
      : (originalname || "upload").trim() || "upload";

  // Resolve before storing so extension-based MIME fallbacks are persisted
  // consistently in both R2 object metadata and the upload record.
  const mimetype = resolveMimetype(declaredType, filename);

  if (!mimetype) {
    throw new ApiError(
      415,
      `Unsupported file type: ${declaredType || "unknown"}`,
    );
  }

  const limit = limitFor(mimetype);
  if (buffer.length > limit) {
    throw new ApiError(
      413,
      `File exceeds the ${limit / (1024 * 1024)}MB limit`,
    );
  }

  await verifyFileSignature(buffer, mimetype);
  const metadata = validateMediaMetadata(req.body?.mediaMetadata, mimetype);
  const key = buildKey(filename);
  // The client treats this as an opaque key. Bytes are always served through
  // the authenticated attachment proxy, which checks room membership.
  const fileUrl = `r2://${r2.bucket}/${key}`;
  try {
    await r2.putObject({ key, body: buffer, contentType: mimetype });
  } catch (err) {
    console.error("R2 upload failed", err);
    throw new ApiError(502, "File storage is temporarily unavailable");
  }

  const size = buffer.length;

  // UNIQUE on file_url prevents duplicate unclaimed records for one object.
  try {
    await query(
      `INSERT INTO file_uploads (uploader_id, file_url, filename, mime_type, size_bytes, public_id, resource_type, width, height, preview_url, duration)
       VALUES ($1, $2, $3, $4, $5, $6, 'r2', $7, $8, $9, $10)`,
      [
        req.user.id,
        fileUrl,
        filename,
        mimetype,
        size,
        key,
        metadata.width,
        metadata.height,
        metadata.preview_url,
        metadata.duration,
      ],
    );
  } catch (err) {
    try {
      await r2.deleteObject(key);
    } catch (cleanupError) {
      console.error("R2 orphan cleanup failed", {
        key,
        message: cleanupError.message,
      });
    }
    if (err.code === "23505") {
      throw new ApiError(409, "That file has already been uploaded");
    }
    // 42P01 is undefined_table — the 010 migration has not been run.
    if (err.code === "42P01") {
      throw new ApiError(503, "File uploads are not available on this server");
    }
    throw err;
  }

  // Wrapped in the standard { success, data } envelope every other route uses.
  return ok(
    res,
    {
      filename,
      url: fileUrl,
      mime_type: mimetype,
      size,
      ...metadata,
    },
    201,
  );
});

module.exports = {
  uploadFile,
  buildKey,
  resolveMimetype,
  limitFor,
  ALLOWED_MIME_TYPES,
  EXTENSION_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_BYTES,
};
