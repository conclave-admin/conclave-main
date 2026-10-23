const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { pool, query } = require("../config/db");
const env = require("../config/env");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const ApiError = require("../utils/ApiError");
const { revokeSessionAccess } = require("../services/realtimeAccess.service");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require("../services/token.service");

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
const USER_COLUMNS =
  "id, email, display_name, avatar_url, bio, created_at, email_verified_at";

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function validateCredentials(email, password) {
  if (!email || !password) {
    throw new ApiError(400, "email and password are required");
  }
  const normalized = normalizeEmail(email);
  if (!EMAIL_RE.test(normalized)) {
    throw new ApiError(400, "email is not a valid address");
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new ApiError(
      400,
      `password must be at least ${MIN_PASSWORD} characters`,
    );
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new ApiError(
      400,
      `password must be at most ${MAX_PASSWORD_BYTES} bytes`,
    );
  }
  return normalized;
}

// Convert a JWT duration like '7d' into a Postgres interval literal, so the
// stored token expiry follows JWT_REFRESH_EXPIRES_IN instead of a hardcoded
// INTERVAL '7 days' that silently disagreed with the token itself.
function refreshExpiryInterval() {
  const spec = String(env.jwt.refreshExpiresIn || "").trim();
  const match = /^(\d+)\s*([smhd])$/i.exec(spec);
  if (!match) return "7 days";
  const amount = parseInt(match[1], 10);
  const unit = { s: "seconds", m: "minutes", h: "hours", d: "days" }[
    match[2].toLowerCase()
  ];
  return `${amount} ${unit}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function issueSession(user, req, expectedPasswordHash) {
  const sessionId = crypto.randomUUID();
  const accessToken = signAccessToken({ ...user, sessionId });
  const refreshToken = signRefreshToken({ id: user.id, sessionId });
  // One statement ensures a refresh token never exists without its session.
  const issued = await query(
    `WITH authorized AS MATERIALIZED (
       SELECT id FROM users WHERE id=$2 AND password_hash=$7 AND deleted_at IS NULL FOR NO KEY UPDATE
     ), session AS (
       INSERT INTO auth_sessions (id, user_id, expires_at,device_label,user_agent)
       SELECT $1,id,NOW()+$4::interval,$5,$6 FROM authorized RETURNING id
     ) INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_id)
       SELECT $2, $3, NOW() + $4::interval, id FROM session`,
    [
      sessionId,
      user.id,
      hashToken(refreshToken),
      refreshExpiryInterval(),
      String(req?.body?.deviceLabel || "Browser")
        .trim()
        .slice(0, 80) || "Browser",
      String(req?.headers?.["user-agent"] || "").slice(0, 320),
      expectedPasswordHash,
    ],
  );
  if (issued.rowCount === 0)
    throw new ApiError(401, "Credentials changed. Please sign in again.");
  return { user, accessToken, refreshToken };
}

const register = asyncHandler(async (req, res) => {
  const { displayName } = req.body;

  if (!displayName || !String(displayName).trim()) {
    throw new ApiError(400, "displayName is required");
  }
  const email = validateCredentials(req.body.email, req.body.password);

  // Compare case-insensitively so A@x.com and a@x.com cannot both register.
  // Stored values are normalised on write, so this also matches rows created
  // before normalisation existed.
  const existing = await query("SELECT id FROM users WHERE lower(email) = $1", [
    email,
  ]);
  if (existing.rows.length > 0) {
    throw new ApiError(409, "An account with that email already exists");
  }

  const passwordHash = await bcrypt.hash(req.body.password, 12);

  const result = await query(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING ${USER_COLUMNS}`,
    [email, passwordHash, String(displayName).trim()],
  );

  return ok(res, await issueSession(result.rows[0], req, passwordHash), 201);
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
  if (!user) throw new ApiError(401, "Invalid email or password");

  const matches = await bcrypt.compare(req.body.password, user.password_hash);
  if (!matches) throw new ApiError(401, "Invalid email or password");

  // The database row also contains the credential used above. Never serialize it.
  const { password_hash, ...publicUser } = user;
  return ok(res, await issueSession(publicUser, req, user.password_hash));
});

const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new ApiError(400, "refreshToken is required");

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (err) {
    throw new ApiError(401, "Invalid or expired refresh token");
  }

  if (!payload.sid)
    throw new ApiError(401, "Please sign in again to renew this session");
  const tokenHash = hashToken(refreshToken);
  const client = await pool.connect();
  let committed = false;
  let user;
  try {
    // Rotate: revoke the presented token and issue a replacement in the same
    // transaction, so a stolen refresh token is single-use rather than valid
    // for its full lifetime. FOR UPDATE serialises concurrent refreshes of
    // the same token, so only one of them can win.
    await client.query("BEGIN");

    const stored = await client.query(
      `SELECT s.id FROM auth_sessions s
        JOIN refresh_tokens r ON r.session_id = s.id
        WHERE s.id = $3 AND s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
          AND r.user_id = $1 AND r.token_hash = $2 AND r.revoked_at IS NULL AND r.expires_at > NOW()
        FOR UPDATE OF s, r`,
      [payload.sub, tokenHash, payload.sid],
    );
    if (stored.rows.length === 0) {
      throw new ApiError(
        401,
        "Refresh token not recognized — please log in again",
      );
    }

    const userResult = await client.query(
      `SELECT id, email FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [payload.sub],
    );
    user = userResult.rows[0];
    if (!user) {
      throw new ApiError(401, "User no longer exists");
    }

    const accessToken = signAccessToken({ ...user, sessionId: payload.sid });
    const nextRefresh = signRefreshToken({
      id: user.id,
      sessionId: payload.sid,
    });

    await client.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
      [tokenHash],
    );
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_id)
       VALUES ($1, $2, NOW() + $3::interval, $4)`,
      [user.id, hashToken(nextRefresh), refreshExpiryInterval(), payload.sid],
    );

    await client.query(
      "UPDATE auth_sessions SET expires_at = NOW() + $2::interval WHERE id = $1",
      [payload.sid, refreshExpiryInterval()],
    );
    await client.query("COMMIT");
    committed = true;

    return ok(res, { accessToken, refreshToken: nextRefresh });
  } catch (err) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (typeof refreshToken === "string" && refreshToken) {
    const client = await pool.connect();
    let sessionId;
    try {
      await client.query("BEGIN");
      // Lock the stable session, just as refresh does. A rotated token can
      // still revoke its own session, but never another device's session.
      const result = await client.query(
        `SELECT s.id FROM auth_sessions s JOIN refresh_tokens r ON r.session_id = s.id
          WHERE r.token_hash = $1 FOR UPDATE OF s`,
        [hashToken(refreshToken)],
      );
      sessionId = result.rows[0]?.id;
      if (sessionId) {
        await client.query(
          "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1",
          [sessionId],
        );
        await client.query(
          "UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE session_id = $1",
          [sessionId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    const io = req.app.get("io");
    if (sessionId && io) {
      await revokeSessionAccess(io, sessionId);
    }
  }
  return ok(res, { message: "Logged out" });
});

module.exports = { register, login, refresh, logout };
