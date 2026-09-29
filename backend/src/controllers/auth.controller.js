const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { pool, query } = require('../config/db');
const env = require('../config/env');
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

// Deliberately permissive; the point is to catch typos, not to re-implement
// RFC 5322. Anything this rejects, the client form should have caught first.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
// bcrypt only considers the first 72 bytes and silently ignores the rest, so
// reject longer input rather than let a user believe a long passphrase is
// fully protected.
const MAX_PASSWORD_BYTES = 72;

// One user shape for every auth response. register and login previously
// returned different field sets (BACKEND_TASKS.md Bug 11).
const USER_COLUMNS = 'id, email, display_name, avatar_url, bio, created_at';

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function validateCredentials(email, password) {
  if (!email || !password) {
    throw new ApiError(400, 'email and password are required');
  }
  const normalized = normalizeEmail(email);
  if (!EMAIL_RE.test(normalized)) {
    throw new ApiError(400, 'email is not a valid address');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new ApiError(400, `password must be at least ${MIN_PASSWORD} characters`);
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new ApiError(400, `password must be at most ${MAX_PASSWORD_BYTES} bytes`);
  }
  return normalized;
}

// Convert a JWT duration like '7d' into a Postgres interval literal, so the
// stored token expiry follows JWT_REFRESH_EXPIRES_IN instead of a hardcoded
// INTERVAL '7 days' that silently disagreed with the token itself.
function refreshExpiryInterval() {
  const spec = String(env.jwt.refreshExpiresIn || '').trim();
  const match = /^(\d+)\s*([smhd])$/i.exec(spec);
  if (!match) return '7 days';
  const amount = parseInt(match[1], 10);
  const unit = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' }[match[2].toLowerCase()];
  return `${amount} ${unit}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueSession(user) {
  const accessToken = signAccessToken({ id: user.id, email: user.email });
  const refreshToken = signRefreshToken({ id: user.id });

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + $3::interval)`,
    [user.id, hashToken(refreshToken), refreshExpiryInterval()],
  );

  return { user, accessToken, refreshToken };
}

const register = asyncHandler(async (req, res) => {
  const { displayName } = req.body;

  if (!displayName || !String(displayName).trim()) {
    throw new ApiError(400, 'displayName is required');
  }
  const email = validateCredentials(req.body.email, req.body.password);

  // Compare case-insensitively so A@x.com and a@x.com cannot both register.
  // Stored values are normalised on write, so this also matches rows created
  // before normalisation existed.
  const existing = await query('SELECT id FROM users WHERE lower(email) = $1', [email]);
  if (existing.rows.length > 0) {
    throw new ApiError(409, 'An account with that email already exists');
  }

  const passwordHash = await bcrypt.hash(req.body.password, 12);

  const result = await query(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING ${USER_COLUMNS}`,
    [email, passwordHash, String(displayName).trim()],
  );

  return ok(res, await issueSession(result.rows[0]), 201);
});

const login = asyncHandler(async (req, res) => {
  const email = validateCredentials(req.body.email, req.body.password);

  const result = await query(
    `SELECT ${USER_COLUMNS}, password_hash
       FROM users
      WHERE lower(email) = $1 AND deleted_at IS NULL`,
    [email],
  );
  const user = result.rows[0];
  // Same message whether the account is missing, soft-deleted, or the
  // password is wrong, so the endpoint is not a user-enumeration oracle.
  if (!user) throw new ApiError(401, 'Invalid email or password');

  const matches = await bcrypt.compare(req.body.password, user.password_hash);
  if (!matches) throw new ApiError(401, 'Invalid email or password');

  return ok(res, await issueSession(user));
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
  const client = await pool.connect();
  let committed = false;
  let user;
  try {
    // Rotate: revoke the presented token and issue a replacement in the same
    // transaction, so a stolen refresh token is single-use rather than valid
    // for its full lifetime. FOR UPDATE serialises concurrent refreshes of
    // the same token, so only one of them can win.
    await client.query('BEGIN');

    const stored = await client.query(
      `SELECT 1 FROM refresh_tokens
        WHERE user_id = $1 AND token_hash = $2 AND revoked_at IS NULL AND expires_at > NOW()
        FOR UPDATE`,
      [payload.sub, tokenHash],
    );
    if (stored.rows.length === 0) {
      throw new ApiError(401, 'Refresh token not recognized — please log in again');
    }

    const userResult = await client.query(
      `SELECT id, email FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [payload.sub],
    );
    user = userResult.rows[0];
    if (!user) {
      throw new ApiError(401, 'User no longer exists');
    }

    const accessToken = signAccessToken(user);
    const nextRefresh = signRefreshToken({ id: user.id });

    await client.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
      [tokenHash],
    );
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + $3::interval)`,
      [user.id, hashToken(nextRefresh), refreshExpiryInterval()],
    );

    await client.query('COMMIT');
    committed = true;

    return ok(res, { accessToken, refreshToken: nextRefresh });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(refreshToken)],
    );
  }
  // Always the same response either way, so this cannot be used to probe
  // whether a token is live.
  return ok(res, { message: 'Logged out' });
});

module.exports = { register, login, refresh, logout };
