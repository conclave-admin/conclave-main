const { query } = require("../config/db");
const ApiError = require("../utils/ApiError");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessionRoom = (id) => `session:${id}`;

async function requireSession(claims) {
  if (!UUID.test(claims?.sid || "") || !UUID.test(claims?.sub || "")) {
    throw new ApiError(401, "Please sign in again to renew this session");
  }
  const result = await query(
    `SELECT s.id, s.user_id, s.expires_at,u.suspended_at,
       (SELECT COUNT(*)::integer FROM auth_sessions active
         WHERE active.user_id=s.user_id AND active.revoked_at IS NULL
           AND active.expires_at>NOW()) AS active_session_count
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
        AND s.expires_at > NOW() AND u.deleted_at IS NULL`,
    [claims.sid, claims.sub],
  );
  if (!result.rows.length)
    throw new ApiError(
      401,
      "Session expired or revoked — please sign in again",
    );
  if (result.rows[0].suspended_at)
    throw new ApiError(403, "This account is suspended");
  await query(
    "UPDATE auth_sessions SET last_active_at=NOW() WHERE id=$1 AND last_active_at<NOW()-INTERVAL '5 minutes'",
    [claims.sid],
  );
  return result.rows[0];
}

module.exports = { requireSession, sessionRoom };
