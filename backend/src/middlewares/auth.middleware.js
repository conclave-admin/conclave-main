const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { query } = require('../config/db');

// Verifies the access token in the Authorization header and attaches
// { id, email } to req.user. Use on every protected REST route.
//
// A valid signature is not enough on its own. `DELETE /users/me` is a soft
// delete, and a self-contained JWT cannot be revoked, so without the
// deleted_at check below a deleted account kept full access to every route
// until its access token expired — up to 15 minutes. This closes that window.
//
// The cost is one indexed primary-key lookup per authenticated request, which
// is the price of a JWT that cannot be invalidated. If this ever needs to go,
// the fix is a short-TTL check with a cache, not removing the lookup: the
// lookup is what makes deletion actually mean anything.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return next(new ApiError(401, 'Missing access token'));
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwt.accessSecret);
  } catch (err) {
    return next(new ApiError(401, 'Invalid or expired access token'));
  }

  try {
    const result = await query(
      `SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [payload.sub],
    );
    if (result.rows.length === 0) {
      return next(new ApiError(401, 'This account has been deleted'));
    }
  } catch (err) {
    // A database failure is not an authentication failure. Returning 401 here
    // would sign every user out during an outage, so let it surface as a 500.
    return next(err);
  }

  req.user = { id: payload.sub, email: payload.email };
  return next();
}

module.exports = requireAuth;
