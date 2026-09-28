const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const ApiError = require('../utils/ApiError');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require('../services/token.service');

// This controller is fully wired up as the reference pattern for the rest
// of the API: validate input -> hit the DB -> return a consistent shape.
// Everything else in /controllers follows this same structure.

const register = asyncHandler(async (req, res) => {
  const { email, password, displayName } = req.body;

  if (!email || !password || !displayName) {
    throw new ApiError(400, 'email, password and displayName are required');
  }

  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    throw new ApiError(409, 'An account with that email already exists');
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await query(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, display_name, created_at`,
    [email, passwordHash, displayName]
  );

  const user = result.rows[0];
  const accessToken = signAccessToken({ id: user.id, email: user.email });
  const refreshToken = signRefreshToken({ id: user.id });

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
    [user.id, hashToken(refreshToken)]
  );

  return ok(res, { user, accessToken, refreshToken }, 201);
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    throw new ApiError(400, 'email and password are required');
  }

  const result = await query(
    'SELECT id, email, display_name, password_hash FROM users WHERE email = $1 AND deleted_at IS NULL',
    [email]
  );
  const user = result.rows[0];
  if (!user) throw new ApiError(401, 'Invalid email or password');

  const matches = await bcrypt.compare(password, user.password_hash);
  if (!matches) throw new ApiError(401, 'Invalid email or password');

  const accessToken = signAccessToken({ id: user.id, email: user.email });
  const refreshToken = signRefreshToken({ id: user.id });

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
    [user.id, hashToken(refreshToken)]
  );

  delete user.password_hash;
  return ok(res, { user, accessToken, refreshToken });
});

const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new ApiError(400, 'refreshToken is required');

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (err) {
    throw new ApiError(401, 'Invalid or expired refresh token');
  }

  const tokenHash = hashToken(refreshToken);
  const stored = await query(
    `SELECT id FROM refresh_tokens
     WHERE user_id = $1 AND token_hash = $2 AND revoked_at IS NULL AND expires_at > NOW()`,
    [payload.sub, tokenHash]
  );
  if (stored.rows.length === 0) {
    throw new ApiError(401, 'Refresh token not recognized — please log in again');
  }

  const userResult = await query('SELECT id, email FROM users WHERE id = $1 AND deleted_at IS NULL', [payload.sub]);
  const user = userResult.rows[0];
  if (!user) throw new ApiError(401, 'User no longer exists');

  const accessToken = signAccessToken(user);
  return ok(res, { accessToken });
});

const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
      [hashToken(refreshToken)]
    );
  }
  return ok(res, { message: 'Logged out' });
});

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { register, login, refresh, logout };
