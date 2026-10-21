// The accept lists for the attach menu, mirrored from ALLOWED_MIME_TYPES in
// backend/src/controllers/upload.controller.js.
//
// These are enumerated rather than written as `image/*` and `video/*` because
// the server is enumerated too. A broad `video/*` would offer .avi and .mkv,
// which the server refuses with a 415, so the browser's filter would promise a
// type the upload then rejects.

/** The ceiling for everything except video. Mirrors the controller. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Video gets a higher ceiling. Mirrors MAX_VIDEO_BYTES in the controller. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/** Selection limit. Each picked item becomes its own message. */
export const MAX_ATTACHMENTS = 10;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp'];

/** What "Photos & videos" and "Camera" may pick. */
export const PHOTO_ACCEPT = [...IMAGE_TYPES, ...VIDEO_TYPES].join(',');

/** What "Document" may pick: everything the server accepts that is not an image or video. */
export const DOCUMENT_ACCEPT = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/gzip',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/mp4',
].join(',');

export const isImage = (file) => (file?.type || '').startsWith('image/');
export const isVideo = (file) => (file?.type || '').startsWith('video/');

/** The size ceiling that applies to this file. */
export const limitFor = (file) => (isVideo(file) ? MAX_VIDEO_BYTES : MAX_UPLOAD_BYTES);

const VIDEO_EXTENSIONS = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.3gp': 'video/3gpp',
};

/**
 * Give a video with a blank type the type the server will infer from its
 * extension, so the preview and the upload agree. Browsers report '' for .mov
 * on several platforms, and a blank type would otherwise preview as a generic
 * file. Everything else is returned untouched.
 */
export function normaliseFile(file) {
  if (file.type) return file;
  const dot = file.name.lastIndexOf('.');
  const type = dot < 0 ? undefined : VIDEO_EXTENSIONS[file.name.slice(dot).toLowerCase()];
  return type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file;
}

const MAX_EDGE = 1600;
const QUALITY = 0.82;

/**
 * Shrink a photo before it is uploaded, as WhatsApp does. Transparent PNGs are
 * flattened onto white. Falls back to the original if anything goes wrong or
 * the result is not smaller.
 */
export async function compressImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
  if (typeof createImageBitmap !== 'function') return file;

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));

    if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
      bitmap.close();
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}

/**
 * Whether the server would accept this file's declared type.
 *
 * Checked before the upload rather than after, so a rejection is an immediate
 * message naming the file instead of a multi-second round trip that ends in a
 * bare 415.
 *
 * @param {string} type - the file's `type`, which browsers leave blank for
 *   extensions they do not recognise (`.md` is the common case)
 * @param {string} filename - used as the fallback when `type` is blank
 */
export function isAccepted(type, filename = '') {
  const all = `${PHOTO_ACCEPT},${DOCUMENT_ACCEPT}`.split(',');
  if (type && all.includes(type)) return true;

  // Browsers report '' for .md, .mov and several audio containers, so the
  // extension is the only signal the client has. The server still checks the
  // declared type first, so this only narrows what we offer to send.
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : '';
  const byExtension = {
    '.md': ['text/markdown', 'text/plain'],
    '.txt': ['text/plain'],
    '.csv': ['text/csv'],
    '.jpg': ['image/jpeg'],
    '.jpeg': ['image/jpeg'],
    '.png': ['image/png'],
    '.gif': ['image/gif'],
    '.webp': ['image/webp'],
    '.svg': ['image/svg+xml'],
    '.pdf': ['application/pdf'],
    '.zip': ['application/zip'],
    '.gz': ['application/gzip'],
    '.doc': ['application/msword'],
    '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    '.xls': ['application/vnd.ms-excel'],
    '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    '.ppt': ['application/vnd.ms-powerpoint'],
    '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    '.mp3': ['audio/mpeg'],
    '.ogg': ['audio/ogg'],
    '.wav': ['audio/wav'],
    '.weba': ['audio/webm'],
    '.m4a': ['audio/mp4'],
    '.mp4': ['video/mp4', 'audio/mp4'],
    '.m4v': ['video/mp4'],
    '.mov': ['video/quicktime'],
    '.webm': ['video/webm', 'audio/webm'],
    '.3gp': ['video/3gpp'],
  };

  const allowed = byExtension[ext];
  if (!allowed) return false;
  return !type || allowed.includes(type);
}
