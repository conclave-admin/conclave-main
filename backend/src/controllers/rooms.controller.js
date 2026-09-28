const { pool, query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const ApiError = require("../utils/ApiError");

// Valid room types matching the DB CHECK / schema comment
const VALID_TYPES = ["dm", "group"];

// ---------- createRoom ----------
// Creates a room and inserts the creator as an admin member in one transaction.
const createRoom = asyncHandler(async (req, res) => {
  const { name, type, memberIds } = req.body;

  if (!name || !name.trim()) {
    throw new ApiError(400, "Room name is required");
  }
  const roomType = type || (memberIds?.length === 1 ? "dm" : "group"); // Default to "dm" if exactly 1 other member, else "group"
  if (!VALID_TYPES.includes(roomType)) {
    throw new ApiError(
      400,
      `Invalid room type. Must be one of: ${VALID_TYPES.join(", ")}`,
    );
  }

  // For DM rooms, ensure exactly 1 other member is provided
  if (roomType === "dm") {
    if (!Array.isArray(memberIds) || memberIds.length !== 1) {
      throw new ApiError(
        400,
        "DM rooms must have exactly one other member (memberIds: [userId])",
      );
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Insert the room
    const roomResult = await client.query(
      `INSERT INTO rooms (name, type, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, name, type, created_by, created_at`,
      [name.trim(), roomType, req.user.id],
    );
    const room = roomResult.rows[0];

    // 2. Insert creator as admin member
    await client.query(
      `INSERT INTO room_members (room_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [room.id, req.user.id],
    );

    // 3. If memberIds provided, add them as regular members
    if (Array.isArray(memberIds) && memberIds.length > 0) {
      for (const memberId of memberIds) {
        // Skip the creator (already added as admin above)
        if (memberId === req.user.id) continue;
        await client.query(
          `INSERT INTO room_members (room_id, user_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (room_id, user_id) DO NOTHING`,
          [room.id, memberId],
        );
      }
    }

    await client.query("COMMIT");

    return ok(
      res,
      { ...room, members: [req.user.id, ...(memberIds || [])] },
      201,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// ---------- listRooms ----------
// Returns all rooms the authenticated user is a member of, with member count
// and the user's role in each room.
const listRooms = asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT
       r.id,
       r.name,
       r.type,
       r.created_by,
       r.created_at,
       rm.role AS my_role,
       rm.joined_at,
       rm.last_seen_at,
       COUNT(all_members.user_id)::int AS member_count
     FROM rooms r
     INNER JOIN room_members rm
       ON rm.room_id = r.id
      AND rm.user_id = $1
     INNER JOIN room_members all_members
       ON all_members.room_id = r.id
     GROUP BY
       r.id,
       r.name,
       r.type,
       r.created_by,
       r.created_at,
       rm.role,
       rm.joined_at,
       rm.last_seen_at
     ORDER BY r.created_at DESC`,
    [req.user.id],
  );

  return ok(res, result.rows);
});

// ---------- getRoom ----------
// Fetches a single room. Verifies the caller is a member.
// Returns room details + list of members.
const getRoom = asyncHandler(async (req, res) => {
  const { roomId } = req.params;

  // 1. Fetch room details, check caller membership, and aggregate members cleanly.
  const result = await query(
    `SELECT
       r.id,
       r.name,
       r.type,
       r.created_by,
       r.created_at,
       (
         SELECT rm.role
         FROM room_members rm
         WHERE rm.room_id = r.id AND rm.user_id = $2
       ) AS my_role,
       COALESCE(
         (
           SELECT json_agg(
             json_build_object(
               'id', u.id,
               'display_name', u.display_name,
               'avatar_url', u.avatar_url,
               'role', rm2.role,
               'joined_at', rm2.joined_at,
               'last_seen_at', rm2.last_seen_at
             )
             ORDER BY rm2.role = 'admin' DESC,
                      rm2.joined_at ASC,
                      rm2.user_id ASC
           )
           FROM room_members rm2
           INNER JOIN users u ON u.id = rm2.user_id
           WHERE rm2.room_id = r.id
         ),
         '[]'::json
       ) AS members
     FROM rooms r
     WHERE r.id = $1`,
    [roomId, req.user.id],
  );

  // 2. Verify that the room exists.
  if (result.rows.length === 0) {
    throw new ApiError(404, "Room not found");
  }

  // 3. Verify that the authenticated user is a room member.
  const { my_role, members, ...room } = result.rows[0];
  if (!my_role) {
    throw new ApiError(403, "You are not a member of this room");
  }

  // 4. Return the room details and its member list.
  return ok(res, { ...room, members });
});

// ---------- addMember ----------
// Adds a user to a room. The caller must be an admin of the room.
const addMember = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const { userId } = req.body;

  if (!userId) {
    throw new ApiError(400, "userId is required");
  }

  // 1. Validate room exists, target user exists, caller is an admin.
  const check = await query(
    `SELECT
       (SELECT type FROM rooms WHERE id = $1) AS room_type,
       (SELECT display_name FROM users WHERE id = $2) AS display_name,
       (SELECT role FROM room_members WHERE room_id = $1 AND user_id = $3) AS caller_role`,
    [roomId, userId, req.user.id],
  );

  const { room_type, display_name, caller_role } = check.rows[0];

  if (!room_type) throw new ApiError(404, "Room not found");
  if (!display_name) throw new ApiError(404, "User not found");
  if (!caller_role) throw new ApiError(403, "You are not a member of this room");
  if (caller_role !== "admin") throw new ApiError(403, "Only room admins can add members");

  // 2. Insert the member + create notification in a single transaction.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insertResult = await client.query(
      `INSERT INTO room_members (room_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (room_id, user_id) DO NOTHING
       RETURNING user_id`,
      [roomId, userId],
    );

    if (insertResult.rows.length === 0) {
      throw new ApiError(409, "User is already a member of this room");
    }

    await client.query(
      `INSERT INTO notifications (recipient_id, type, reference_id)
       VALUES ($1, 'room_invite', $2)`,
      [userId, roomId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return ok(
    res,
    {
      roomId,
      userId,
      displayName: display_name,
      role: "member",
    },
    201,
  );
});

// ---------- markRoomSeen ----------
// Stamps room_members.last_seen_at for the caller. This is the only writer of
// that column, and the digest depends on it: until it moves, every digest
// reports everything since the user joined the room (BACKEND_TASKS.md Bug 2).
// Called by the client when a room is opened, and by the socket on leave-room.
const markRoomSeen = asyncHandler(async (req, res) => {
  const { roomId } = req.params;

  const result = await query(
    `UPDATE room_members
        SET last_seen_at = NOW()
      WHERE room_id = $1 AND user_id = $2
      RETURNING last_seen_at`,
    [roomId, req.user.id],
  );

  if (result.rows.length === 0) {
    throw new ApiError(403, "You are not a member of this room");
  }

  return ok(res, { roomId, lastSeenAt: result.rows[0].last_seen_at });
});

module.exports = { createRoom, listRooms, getRoom, addMember, markRoomSeen };
