const ApiError = require('./ApiError');

// This is display metadata supplied by a device, not proof of the file's type.
// Only a bounded raster thumbnail is allowed; URLs and active SVG are refused.
function validateMediaMetadata(value, mime) {
  if (!value) return { width: null, height: null, preview_url: null, duration: null };
  let data;
  try { data = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new ApiError(400, 'Invalid media metadata'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(400, 'Invalid media metadata');
  const media = /^(image|video)\//.test(mime);
  const { width = null, height = null, preview_url = null, duration = null } = data;
  if ((width !== null || height !== null) && (!media || ![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 32768))) {
    throw new ApiError(400, 'Invalid media dimensions');
  }
  if (duration !== null && (!mime.startsWith('video/') || !Number.isFinite(duration) || duration <= 0 || duration > 604800)) {
    throw new ApiError(400, 'Invalid video duration');
  }
  if (preview_url !== null) {
    if (!media || typeof preview_url !== 'string' || preview_url.length > 16407 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(preview_url)) {
      throw new ApiError(400, 'Invalid media thumbnail');
    }
    const bytes = Buffer.from(preview_url.slice(23), 'base64');
    if (bytes.length > 12288 || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) {
      throw new ApiError(400, 'Invalid media thumbnail');
    }
  }
  return { width, height, preview_url, duration };
}
module.exports = { validateMediaMetadata };
