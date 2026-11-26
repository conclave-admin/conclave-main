const jwt = require("jsonwebtoken");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");

const { requireSession } = require("../services/session.service");

// REST and realtime use the same durable, revocable session identity.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return next(new ApiError(401, "Missing access token"));
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwt.accessSecret);
  } catch (err) {
    return next(new ApiError(401, "Invalid or expired access token"));
  }

  try {
    await requireSession(payload);
  } catch (err) {
    // A database failure is not an authentication failure. Returning 401 here
    // would sign every user out during an outage, so let it surface as a 500.
    return next(err);
  }

  req.user = { id: payload.sub, email: payload.email, sessionId: payload.sid };
  return next();
}

module.exports = requireAuth;
