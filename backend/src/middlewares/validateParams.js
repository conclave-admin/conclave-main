const ApiError = require('../utils/ApiError');

// Matches the canonical Postgres UUID form (8-4-4-4-12 hex).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Any route param whose name ends in "Id" is expected to be a UUID. Validating
// here turns a malformed path like /rooms/abc into a clear 400 instead of a
// Postgres 22P02 that reaches the client as an opaque failure
// (BACKEND_TASKS.md Bug 14).
function validateUuidParams(req, res, next) {
  for (const [key, value] of Object.entries(req.params || {})) {
    if (!key.endsWith('Id')) continue;
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      return next(
        new ApiError(400, `Invalid ${key}: expected a UUID, received "${value}"`)
      );
    }
  }
  return next();
}

module.exports = validateUuidParams;
