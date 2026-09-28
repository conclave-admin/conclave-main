const ApiError = require('../utils/ApiError');
const { fail } = require('../utils/apiResponse');

// Postgres SQLSTATE codes we can translate into something a client can act on.
// Without this, a malformed :roomId raised a driver error that surfaced as an
// opaque 500 (BACKEND_TASKS.md Bug 14).
const PG_ERRORS = {
  // invalid_text_representation — e.g. a non-UUID passed where a UUID is expected
  '22P02': { status: 400, message: 'Malformed identifier: expected a valid UUID' },
  // foreign_key_violation — referenced row does not exist
  '23503': { status: 400, message: 'Referenced record does not exist' },
  // unique_violation
  '23505': { status: 409, message: 'That record already exists' },
  // not_null_violation
  '23502': { status: 400, message: 'A required field was missing' },
  // check_violation
  '23514': { status: 400, message: 'A field failed validation' },
  // string_data_right_truncation — value too long for the column
  '22001': { status: 400, message: 'A field was too long' },
};

// eslint-disable-next-line no-unused-vars
function errorMiddleware(err, req, res, next) {
  if (err instanceof ApiError) {
    return fail(res, err.message, err.status);
  }

  // Multer surfaces upload problems (including oversize files) as MulterError.
  // Without this branch a 25MB-limit rejection became a 500.
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return fail(res, 'File is larger than the 25MB limit', 413);
    }
    return fail(res, err.message, 400);
  }

  // express.json() rejects malformed or oversized bodies with a status.
  if (err && err.type === 'entity.parse.failed') {
    return fail(res, 'Request body is not valid JSON', 400);
  }
  if (err && err.type === 'entity.too.large') {
    return fail(res, 'Request body is too large', 413);
  }

  const mapped = err && err.code ? PG_ERRORS[err.code] : null;
  if (mapped) {
    return fail(res, mapped.message, mapped.status);
  }

  console.error(err);
  return fail(res, 'Internal server error', 500);
}

module.exports = errorMiddleware;
