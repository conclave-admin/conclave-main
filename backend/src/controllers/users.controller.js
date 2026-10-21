const { pool, query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const ApiError = require('../utils/ApiError');
const r2 = require('../config/r2');

const UPDATABLE_FIELDS = ['display_name', 'avatar_url', 'bio'];
const PAGE_SIZE = 25;

// Resolve an opaque R2 avatar key only when it is currently used by an active
// profile or by a room the requesting user belongs to.
const getAvatarUrl = asyncHandler(async (req, res) => {
  const fileUrl = req.query.url;
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith(`r2://${r2.bucket}/`)) {
    throw new ApiError(400, 'A valid R2 avatar key is required');
  }
  if (!r2.isConfigured()) throw new ApiError(503, 'File storage is not configured');

  const result = await query(
    `SELECT f.public_id, f.mime_type
       FROM file_uploads f
      WHERE f.file_url = $1 AND f.resource_type = 'r2'
        AND f.mime_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')
        AND (
          EXISTS (SELECT 1 FROM users u WHERE u.avatar_url = f.file_url AND u.deleted_at IS NULL)
          OR EXISTS (
            SELECT 1 FROM rooms r
            INNER JOIN room_members rm ON rm.room_id = r.id
            WHERE r.avatar_url = f.file_url AND rm.user_id = $2
          )
        )`,
    [fileUrl, req.user.id],
  );
  if (!result.rows.length) throw new ApiError(404, 'Avatar not found');

  const row = result.rows[0];
  try {
    const url = await r2.signedGetUrl(row.public_id, {
      expiresIn: 3600,
      contentType: row.mime_type,
      inline: true,
    });
    return ok(res, { url, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  } catch (err) {
    console.error('R2 avatar URL signing failed', { code: err.name });
    throw new ApiError(502, 'Avatar storage is temporarily unavailable');
  }
});

// Per-field length ceilings. Without these, updateProfile accepted an
// arbitrarily long avatar_url or bio (BACKEND_TASKS.md Bug 15).
const FIELD_LIMITS = {
  display_name: 100,
  avatar_url: 2048,
  bio: 1000,
};

// ---------- getMe ----------
const getMe = asyncHandler(async (req, res) => {
  const result = await query(
    'SELECT id, email, display_name, avatar_url, bio, created_at FROM users WHERE id = $1 AND deleted_at IS NULL',
    [req.user.id]
  );
  if (result.rows.length === 0) {
    throw new ApiError(404, 'User not found');
  }
  return ok(res, result.rows[0]);
});

// ---------- updateProfile ----------
// Whitelist-only update: only display_name, avatar_url, bio can change here.
// Email/password changes need their own, more carefully guarded endpoints
// later (not added yet — changing email should probably re-verify it,
// changing password needs the current password confirmed).
const updateProfile = asyncHandler(async (req, res) => {
  // 1. Whitelist: pull out only the fields we allow, ignore everything else
  const updates = {};
  for (const field of UPDATABLE_FIELDS) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (Object.keys(updates).length === 0) {
    throw new ApiError(
      400,
      `No updatable fields provided. Allowed: ${UPDATABLE_FIELDS.join(', ')}`
    );
  }

  if ('display_name' in updates && !String(updates.display_name).trim()) {
    throw new ApiError(400, 'display_name cannot be empty');
  }

  for (const [field, value] of Object.entries(updates)) {
    const limit = FIELD_LIMITS[field];
    if (limit === undefined) continue;
    if (value !== null && String(value).length > limit) {
      throw new ApiError(400, `${field} must be at most ${limit} characters`);
    }
  }

  // 2. Build a dynamic SET clause from only the whitelisted fields present
  //    in this request — never string-interpolate values, only column names
  //    from our own constant list above.
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [field, value] of Object.entries(updates)) {
    setClauses.push(`${field} = $${i}`);
    values.push(field === 'display_name' ? String(value).trim() : value);
    i += 1;
  }
  values.push(req.user.id);

  // 3. Apply the update, return the fresh row
  const result = await query(
    `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${i}
     RETURNING id, email, display_name, avatar_url, bio, created_at`,
    values
  );

  if (result.rows.length === 0) {
    throw new ApiError(404, 'User not found');
  }

  return ok(res, result.rows[0]);
});

// ---------- listUsers ----------
// Paginated user directory, optionally filtered by a search term matching
// display_name or email. Email is a search key, not a field other members need
// to see: callers can find a person by a known address without harvesting the
// directory's addresses.
const listUsers = asyncHandler(async (req, res) => {
  const { q, page = '1' } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  const params = [];
  let where = 'WHERE deleted_at IS NULL';
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    where += ` AND (display_name ILIKE $${params.length} OR email ILIKE $${params.length})`;
  }

  params.push(PAGE_SIZE, offset);
  const result = await query(
    `SELECT id, display_name, avatar_url, created_at
     FROM users
     ${where}
     ORDER BY display_name ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return ok(res, {
    users: result.rows,
    page: pageNum,
    pageSize: PAGE_SIZE,
    hasMore: result.rows.length === PAGE_SIZE,
  });
});

// ---------- searchUsers ----------
// A picker-safe subset of listUsers, for the "start a conversation" and
// "add a member" screens.
//
// listUsers returns `email` to every authenticated caller, which is defensible
// for an admin directory and wrong for a people picker: a compose box would
// hand every user's email address to anyone who can type a name. This endpoint
// exists so those two screens have a path that cannot leak one.
//
// Email is still searchable — you can type an address and find the person it
// belongs to — it is just never returned.
const searchUsers = asyncHandler(async (req, res) => {
  const { q, page = '1' } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  // An empty query would return the whole directory, which is not a search.
  // "Recent" is a different screen with a different answer; this one answers
  // "find someone I have a name for".
  if (!q || !q.trim()) {
    return ok(res, { users: [], page: pageNum, pageSize: PAGE_SIZE, hasMore: false });
  }

  const result = await query(
    `SELECT id, display_name, avatar_url
     FROM users
     WHERE deleted_at IS NULL
       AND (display_name ILIKE $1 OR email ILIKE $1)
     ORDER BY display_name ASC
     LIMIT $2 OFFSET $3`,
    [`%${q.trim()}%`, PAGE_SIZE, offset]
  );

  return ok(res, {
    users: result.rows,
    page: pageNum,
    pageSize: PAGE_SIZE,
    hasMore: result.rows.length === PAGE_SIZE,
  });
});

const listSharedRooms = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  if (userId === req.user.id) throw new ApiError(400, 'Cannot list shared rooms with yourself');
  const target = await query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!target.rows.length) throw new ApiError(404, 'User not found');
  const result = await query(
    `SELECT r.id, r.name, r.type, r.slug, r.avatar_url, r.created_at,
            COUNT(DISTINCT rm_all.user_id)::int AS member_count
       FROM room_members mine
       INNER JOIN room_members theirs ON theirs.room_id = mine.room_id AND theirs.user_id = $2
       INNER JOIN rooms r ON r.id = mine.room_id AND r.type <> 'dm'
       INNER JOIN room_members rm_all ON rm_all.room_id = r.id
      WHERE mine.user_id = $1
      GROUP BY r.id
      ORDER BY r.name ASC`,
    [req.user.id, userId],
  );
  return ok(res, { rooms: result.rows });
});

const getBlockStatus = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  if (userId === req.user.id) throw new ApiError(400, 'Cannot check a block against yourself');
  const target = await query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!target.rows.length) throw new ApiError(404, 'User not found');
  const result = await query(
    'SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2',
    [req.user.id, userId],
  );
  return ok(res, { blocked: result.rows.length > 0 });
});

const blockUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  if (userId === req.user.id) throw new ApiError(400, 'Cannot block yourself');
  const target = await query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!target.rows.length) throw new ApiError(404, 'User not found');
  await query(
    `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)
     ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
    [req.user.id, userId],
  );
  return ok(res, { userId, blocked: true });
});

const unblockUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  await query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.user.id, userId]);
  return ok(res, { userId, blocked: false });
});

const reportUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { reason, details, roomId } = req.body || {};
  const allowedReasons = new Set(['spam', 'harassment', 'inappropriate_content', 'impersonation', 'other']);
  if (userId === req.user.id) throw new ApiError(400, 'Cannot report yourself');
  if (!allowedReasons.has(reason)) throw new ApiError(400, 'Choose a valid report reason');
  if (details != null && String(details).length > 1000) throw new ApiError(400, 'details must be at most 1000 characters');
  const target = await query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!target.rows.length) throw new ApiError(404, 'User not found');
  if (roomId) {
    const membership = await query(
      `SELECT 1 FROM room_members reporter
       INNER JOIN room_members reported ON reported.room_id = reporter.room_id AND reported.user_id = $3
       WHERE reporter.room_id = $1 AND reporter.user_id = $2`,
      [roomId, req.user.id, userId],
    );
    if (!membership.rows.length) throw new ApiError(403, 'Both people must be members of the reported conversation');
  }
  const result = await query(
    `INSERT INTO user_reports (reporter_id, reported_user_id, room_id, reason, details)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, reason, status, created_at`,
    [req.user.id, userId, roomId || null, reason, details?.trim() || null],
  );
  return ok(res, result.rows[0], 201);
});

// ---------- deleteMe ----------
// Soft-delete the authenticated user's account. Anonymizes profile data,
// kills all sessions, and removes room memberships in a transaction.
// Messages, decisions, and tasks are preserved — they still reference
// sender_id/created_by which still exists; the JOIN on users returns
// "Deleted user" for display.
const deleteMe = asyncHandler(async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Anonymize and mark deleted
    await client.query(
      `UPDATE users
       SET deleted_at = NOW(),
           email = NULL,
           password_hash = '',
           display_name = 'Deleted user',
           avatar_url = NULL,
           bio = NULL
       WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.id],
    );

    // 2. Kill all sessions (refresh tokens)
    await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user.id]);

    // 3. Remove from all rooms
    await client.query('DELETE FROM room_members WHERE user_id = $1', [req.user.id]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Revoke active realtime sessions across API instances as soon as the
  // transaction commits. REST requests also reject deleted accounts, but an
  // already-connected socket would otherwise keep working until disconnect.
  const io = req.app.get('io');
  if (io) io.in(`user:${req.user.id}`).disconnectSockets(true);

  return ok(res, { message: 'Account deleted' });
});

module.exports = {
  getMe, updateProfile, listUsers, searchUsers, listSharedRooms, getAvatarUrl,
  getBlockStatus, blockUser, unblockUser, reportUser, deleteMe,
};
