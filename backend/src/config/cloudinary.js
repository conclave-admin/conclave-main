const cloudinary = require('cloudinary').v2;
const env = require('./env');

cloudinary.config({
  cloud_name: env.cloudinary.cloudName,
  api_key: env.cloudinary.apiKey,
  api_secret: env.cloudinary.apiSecret,
});

/**
 * Whether the SDK has usable credentials.
 *
 * The Cloudinary SDK reads CLOUDINARY_URL from the environment and, when it is
 * present, it takes precedence over the explicit config() call above — so the
 * values in env.cloudinary are not necessarily the ones in effect. Checking the
 * resolved config rather than the raw env vars is what makes this accurate when
 * only one of the two forms is populated.
 *
 * Used by upload.controller to return 503 instead of letting a request reach
 * Cloudinary and fail with an opaque upstream error.
 *
 * @returns {boolean}
 */
function isConfigured() {
  const c = cloudinary.config();
  return Boolean(c && c.cloud_name && c.api_key && c.api_secret);
}

module.exports = cloudinary;
module.exports.isConfigured = isConfigured;