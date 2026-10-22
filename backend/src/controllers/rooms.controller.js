const { pool, query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const ApiError = require("../utils/ApiError");
const presence = require("../services/presence.service");
const { revokeRoomAccess } = require("../services/realtimeAccess.service");
const {
  createNotification,
  presentNotification,
  emitNotification,
  UNREAD_COUNT_SQL,
} = require("../services/notification.service");

// The five types named in the rooms.type schema comment. `public` and
// `private` were previously rejected even though RoomList.jsx draws a Hash and
// a Lock for them, so those icons could never appear with real data
// (BACKEND_TASKS.md Bug 3). The comment is still not enforced by a CHECK
// constraint — worth adding once there is a database to validate against.
const VALID_TYPES = ["dm", "group", "public", "private", "department"];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors the slugify expression in migration 008 so a room created now and a
// room backfilled then produce identical slugs.
const SLUG_MAX_ATTEMPTS = 10;

function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "room";
}

// Allocate a slug that no other room holds. rooms.name is not unique, so
// collisions are normal. The unique index is the real guarantee; this
// pre-check just avoids the round trip, and a genuine race surfaces as a 409
// via the Postgres error mapping in error.middleware.js.
async function allocateSlug(client, name) {
  const base = slugify(name);
  for (let attempt = 1; attempt <= SLUG_MAX_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const { rows } = await client.query("SELECT 1 FROM rooms WHERE slug = $1", [
      candidate,
    ]);
    if (rows.length === 0) return candidate;
  }
  throw new ApiError(409, "Could not allocate a unique room slug");
}

// Find an existing 2-member DM between two users, so repeated calls return
// the same conversation instead of minting a new one every time.
async function findExistingDm(userA, userB) {
  const { rows } = await query(
    `SELECT r.id
       FROM rooms r
       INNER JOIN room_members a ON a.room_id = r.id AND a.user_id = $1
       INNER JOIN room_members b ON b.room_id = r.id AND b.user_id = $2
      WHERE r.type = 'dm'
        AND (SELECT COUNT(*) FROM room_members c WHERE c.room_id = r.id) = 2
      LIMIT 1`,
    [userA, userB],
  );
  return rows[0]?.id || null;
}

// ---------- createRoom ----------
// Creates a room and inserts the creator as an admin member in one transaction.
const createRoom = asyncHandler(async (req, res) => {
  const { name, type, memberIds } = req.body;

  const roomType = type || (memberIds?.length === 1 ? "dm" : "group"); // Default to "dm" if exactly 1 other member, else "group"
  if (!VALID_TYPES.includes(roomType)) {
    throw new ApiError(
      400,
      `Invalid room type. Must be one of: ${VALID_TYPES.join(", ")}`,
    );
  }

  // A DM has no title to type — it is named after the other person, and that
  // name is derived on read (see the display_name CASE in listRooms), not from
  // this column. Requiring one anyway meant every DM failed with a 400, because
  // the client has no name to send: it only has the person it picked.
  //
  // Checked after roomType so a request with neither `type` nor a name is judged
  // as the group it is, rather than as a nameless DM.
  if (roomType !== "dm" && (!name || !name.trim())) {
    throw new ApiError(400, "Room name is required");
  }

  if (memberIds !== undefined && !Array.isArray(memberIds)) {
    throw new ApiError(400, "memberIds must be an array of user ids");
  }
  const requested = (memberIds || []).filter((id) => id !== req.user.id);

  const malformed = requested.filter(
    (id) => typeof id !== "string" || !UUID_RE.test(id),
  );
  if (malformed.length > 0) {
    throw new ApiError(
      400,
      `memberIds must all be UUIDs (${malformed.length} invalid)`,
    );
  }

  // For DM rooms, ensure exactly 1 other member is provided
  if (roomType === "dm") {
    if (requested.length !== 1) {
      throw new ApiError(
        400,
        "DM rooms must have exactly one other member (memberIds: [userId])",
      );
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Resolve the invitees before touching rooms. Previously an unknown id
    //    reached the INSERT and came back as a foreign-key error surfaced as a
    //    500; soft-deleted users are rejected here too. display_name is read
    //    alongside id because a nameless DM is named after the other person, and
    //    it would be a second query to ask for it later.
    let found = [];
    if (requested.length > 0) {
      const resolved = await client.query(
        `SELECT id, display_name FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [requested],
      );
      found = resolved.rows;
      const foundIds = new Set(found.map((u) => u.id));
      const missing = requested.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new ApiError(
          400,
          `Unknown or deleted user(s): ${missing.join(", ")}`,
        );
      }
    }

    if (roomType === "dm") {
      const blocked = await client.query(
        `SELECT 1 FROM user_blocks
          WHERE (blocker_id = $1 AND blocked_id = $2)
             OR (blocker_id = $2 AND blocked_id = $1)
          LIMIT 1`,
        [req.user.id, requested[0]],
      );
      if (blocked.rows.length) throw new ApiError(403, "You cannot start a conversation with this user");
    }

    // 2. DMs are unique per pair — return the existing room rather than
    //    creating another one.
    if (roomType === "dm") {
      const existingId = await findExistingDm(req.user.id, requested[0]);
      if (existingId) {
        await client.query("COMMIT");
        const { rows } = await query(
          "SELECT id, name, type, created_by, slug, created_at FROM rooms WHERE id = $1",
          [existingId],
        );
        return ok(res, { ...rows[0], existing: true });
      }
    }

    // 3. A DM with no name takes the other person's. `display_name` is NOT NULL, so
    //    this resolves; the "Direct message" fallback only exists so a future
    //    caller cannot reach the slug allocation with nothing at all.
    const otherMember = found.find((u) => u.id === requested[0]);
    const effectiveName =
      name?.trim() || otherMember?.display_name || "Direct message";

    // 4. Insert the room. The slug is derived server-side, never accepted from
    //    the request, so it cannot be used to squat a handle.
    const slug = await allocateSlug(client, effectiveName);
    const roomResult = await client.query(
      `INSERT INTO rooms (name, type, created_by, slug)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, type, created_by, slug, created_at`,
      [effectiveName, roomType, req.user.id, slug],
    );
    const room = roomResult.rows[0];

    // 5. Insert creator as admin member
    await client.query(
      `INSERT INTO room_members (room_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [room.id, req.user.id],
    );

    // 6. Add the invitees in one statement rather than a query per member.
    if (requested.length > 0) {
      await client.query(
        `INSERT INTO room_members (room_id, user_id, role)
         SELECT $1, u, 'member'
         FROM unnest($2::uuid[]) AS u
         ON CONFLICT (room_id, user_id) DO NOTHING`,
        [room.id, requested],
      );
    }

    // 7. Read the real membership back. The response used to be built from the
    //    request body, so it could advertise members that ON CONFLICT skipped.
    const { rows: members } = await client.query(
      `SELECT u.id, u.display_name, u.avatar_url, rm.role, rm.joined_at
         FROM room_members rm
         INNER JOIN users u ON u.id = rm.user_id
        WHERE rm.room_id = $1
        ORDER BY rm.role = 'admin' DESC, rm.joined_at ASC, rm.user_id ASC`,
      [room.id],
    );

    await client.query("COMMIT");

    return ok(res, { ...room, members }, 201);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// ---------- listRooms ----------
// Returns all rooms the authenticated user is a member of, with member count,
// the user's role in each room, and the two fields the chat list needs:
// a display identity and enough message state to render a row without a
// second round trip.
//
// The shape is purely additive — every column the sidebar reads today is still
// here. The GROUP BY is gone: member_count became a correlated count so the
// LATERAL below isn't trapped inside an aggregate, and so an empty room is
// still a row (a room with no messages must not vanish from the sidebar).
const listRooms = asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT
       r.id,
       r.name,
       r.type,
       r.slug,
       r.avatar_url,
       r.created_by,
       r.created_at,
       rm.role AS my_role,
       rm.joined_at,
       rm.last_seen_at,
       rm.last_seen_sequence,
       COALESCE(rmp.pinned, FALSE) AS is_pinned,
       COALESCE(rmp.muted, FALSE) AS is_muted,
       COALESCE(rmp.archived, FALSE) AS is_archived,
       (SELECT COUNT(*) FROM room_members am WHERE am.room_id = r.id)::int
         AS member_count,

       -- A DM is named after the other person, not the two-word title
       -- createRoom gave it. Groups keep their own name.
       CASE
         WHEN r.type = 'dm' THEN (
           SELECT u.display_name
             FROM room_members o
             INNER JOIN users u ON u.id = o.user_id
            WHERE o.room_id = r.id AND o.user_id <> $1
            LIMIT 1
         )
         ELSE r.name
       END AS display_name,

       CASE
         WHEN r.type = 'dm' THEN (
           SELECT u.avatar_url
             FROM room_members o
             INNER JOIN users u ON u.id = o.user_id
            WHERE o.room_id = r.id AND o.user_id <> $1
            LIMIT 1
         )
         ELSE r.avatar_url
       END AS display_avatar,

       -- LEFT JOIN LATERAL, not CROSS: an empty room returns NULL here rather
       -- than dropping out of the result set entirely.
       lm.id IS NOT NULL AS has_message,
       CASE
         WHEN lm.id IS NULL THEN NULL
         ELSE jsonb_build_object(
           'id',             lm.id,
           -- The row's own tombstone is reported, but its content is never
           -- echoed: a deleted message keeps showing up in the timeline, and
           -- hiding it here would make the sidebar and the room disagree.
           'content',        CASE WHEN lm.deleted_at IS NULL
                                  THEN lm.content ELSE NULL END,
           'sender_id',      lm.sender_id,
           'sender_name',    lm.sender_name,
           'sender_avatar',  lm.sender_avatar,
           'room_sequence',  lm.room_sequence,
           'has_mention',    lm.has_mention,
           'has_attachment', lm.has_attachment,
           'attachment_type', lm.attachment_type,
           'is_deleted',     lm.deleted_at IS NOT NULL,
           'created_at',     lm.created_at
         )
       END AS last_message,

       -- Unread is "a message I have not seen and can still read". Tombstones
       -- are excluded because there would be a badge pointing at nothing, and
       -- the caller's own messages are excluded because no one expects an
       -- unread count on their own words. Shared with emitChatUpdated so the
       -- list row and the sidebar badge can never disagree.
       ${UNREAD_COUNT_SQL} AS unread_count

     FROM rooms r
     INNER JOIN room_members rm
       ON rm.room_id = r.id
      AND rm.user_id = $1
     LEFT JOIN room_member_preferences rmp ON rmp.room_id = r.id AND rmp.user_id = $1
     LEFT JOIN LATERAL (
       SELECT m.id, m.content, m.sender_id, m.created_at, m.deleted_at, m.room_sequence,
              u.display_name AS sender_name,
              u.avatar_url   AS sender_avatar,
              EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)
                AS has_attachment,
              (SELECT a.file_type FROM attachments a WHERE a.message_id = m.id ORDER BY a.id LIMIT 1)
                AS attachment_type,
              EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = $1)
                AS has_mention
         FROM messages m
         INNER JOIN users u ON u.id = m.sender_id
        WHERE m.room_id = r.id
        ORDER BY m.room_sequence DESC
        LIMIT 1
     ) lm ON TRUE
     ORDER BY COALESCE(lm.created_at, r.created_at) DESC, r.id DESC`,
    [req.user.id],
  );

  return ok(res, result.rows);
});

// Public rooms are discoverable to signed-in users who are not members.
// Membership remains required for message/history access; visibility does not
// imply read access. Numeric pages are capped to keep directory queries bounded.
const discoverRooms = asyncHandler(async (req, res) => {
  const page = Math.max(1, Math.min(1000, Number.parseInt(req.query.page, 10) || 1));
  const offset = (page - 1) * 25;
  const term = String(req.query.q || '').trim().slice(0, 100);
  const values = [req.user.id];
  let search = '';
  if (term) {
    values.push(`%${term}%`);
    search = `AND (r.name ILIKE $2 OR COALESCE(r.description, '') ILIKE $2)`;
  }
  values.push(26, offset);
  const result = await query(
    `SELECT r.id, r.name, r.description, r.slug, r.created_at,
            (SELECT COUNT(*)::int FROM room_members rm WHERE rm.room_id = r.id) AS member_count
       FROM rooms r
      WHERE r.type = 'public'
        AND NOT EXISTS (SELECT 1 FROM room_members mine WHERE mine.room_id = r.id AND mine.user_id = $1)
        ${search}
      ORDER BY member_count DESC, r.created_at DESC, r.id DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return ok(res, { rooms: result.rows.slice(0, 25), page, hasMore: result.rows.length > 25 });
});

// Joining an open room and resolving a concurrent duplicate request are one
// transaction. Locking the room row serializes joins with visibility edits.
const joinPublicRoom = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const client = await pool.connect();
  let admins = [];
  let joined = false;
  let notifications = [];
  try {
    await client.query('BEGIN');
    const roomResult = await client.query('SELECT id, type FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    const room = roomResult.rows[0];
    if (!room) throw new ApiError(404, 'Room not found');
    if (room.type !== 'public') throw new ApiError(403, 'This room is not open to join');

    const insert = await client.query(
      `INSERT INTO room_members (room_id, user_id, role)
       VALUES ($1, $2, 'member') ON CONFLICT (room_id, user_id) DO NOTHING RETURNING user_id`,
      [roomId, req.user.id],
    );
    joined = insert.rowCount > 0;
    if (joined) {
      const result = await client.query(
        `SELECT user_id FROM room_members WHERE room_id = $1 AND role = 'admin' AND user_id <> $2`,
        [roomId, req.user.id],
      );
      admins = result.rows.map((row) => row.user_id);
      for (const adminId of admins) {
        notifications.push(await createNotification({
          recipientId: adminId,
          type: 'member_joined',
          referenceId: roomId,
          actorId: req.user.id,
          db: client,
        }));
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const io = req.app.get('io');
  if (joined && io) {
    io.to(roomId).emit('room:members', { roomId, action: 'joined', userId: req.user.id, actorId: req.user.id });
    for (let index = 0; index < admins.length; index += 1) {
      emitNotification(io, admins[index], await presentNotification(notifications[index]));
    }
  }
  return ok(res, { roomId, joined, existing: !joined }, joined ? 201 : 200);
});

const updateRoomPreferences = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const allowed = ['pinned', 'muted', 'archived'];
  const updates = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.includes(key)));
  if (!Object.keys(updates).length || Object.values(updates).some((value) => typeof value !== 'boolean')) {
    throw new ApiError(400, 'Provide pinned, muted, or archived as a boolean');
  }
  const membership = await query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, req.user.id]);
  if (!membership.rows.length) throw new ApiError(404, 'Room not found');
  const values = [roomId, req.user.id, updates.pinned ?? false, updates.muted ?? false, updates.archived ?? false];
  const result = await query(
    `INSERT INTO room_member_preferences (room_id, user_id, pinned, muted, archived)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (room_id, user_id) DO UPDATE SET
       pinned = CASE WHEN $6::boolean THEN $3 ELSE room_member_preferences.pinned END,
       muted = CASE WHEN $7::boolean THEN $4 ELSE room_member_preferences.muted END,
       archived = CASE WHEN $8::boolean THEN $5 ELSE room_member_preferences.archived END,
       updated_at = NOW()
     RETURNING pinned, muted, archived`,
    [...values, 'pinned' in updates, 'muted' in updates, 'archived' in updates],
  );
  return ok(res, result.rows[0]);
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
       r.description,
       r.type,
       r.slug,
       r.avatar_url,
       r.created_by,
       r.created_at,
       -- The same derivation listRooms applies, and it was missing here. That
       -- made a DM answer with two different names — the other person's in the
       -- chat list, the stored two-word title in room info. Rooms are addressed
       -- by id so nothing routes on this, but the two screens should not
       -- disagree about what a room is called.
       CASE
         WHEN r.type = 'dm' THEN (
           SELECT u.display_name
             FROM room_members o
             INNER JOIN users u ON u.id = o.user_id
            WHERE o.room_id = r.id AND o.user_id <> $2
             LIMIT 1
         )
         ELSE r.name
       END AS display_name,
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
               'bio', u.bio,
               'account_created_at', u.created_at,
               'role', rm2.role,
               'joined_at', rm2.joined_at,
               'last_seen_at', rm2.last_seen_at,
               'last_seen_sequence', rm2.last_seen_sequence,
               'last_delivered_sequence', rm2.last_delivered_sequence
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

  // Lock the room before checking permissions. Membership and role mutations
  // use the same lock, preventing a removed/demoted admin from winning a race
  // between their permission check and the write.
  const client = await pool.connect();
  let inviteRow;
  let joinedRows;
  let display_name;
  try {
    await client.query("BEGIN");

    const room = await client.query('SELECT id, type FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    if (!room.rows.length) throw new ApiError(404, "Room not found");
    if (room.rows[0].type === 'dm') throw new ApiError(409, 'Direct messages are one-to-one conversations; create a group to add more people');
    const check = await client.query(
      `SELECT
         (SELECT display_name FROM users WHERE id = $2 AND deleted_at IS NULL) AS display_name,
         (SELECT role FROM room_members WHERE room_id = $1 AND user_id = $3) AS caller_role`,
      [roomId, userId, req.user.id],
    );
    ({ display_name } = check.rows[0]);
    const { caller_role } = check.rows[0];
    if (!display_name) throw new ApiError(404, "User not found or has been deleted");
    if (!caller_role) throw new ApiError(403, "You are not a member of this room");
    if (caller_role !== "admin") throw new ApiError(403, "Only room admins can add members");

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

    // Record who invited, so the notification can read "Victor invited you"
    // rather than just naming the room. The inviter is stored nowhere else, so
    // without this column the information is lost the moment this row is written.
    //
    // Written through the service rather than as raw SQL so there is one
    // type-validated path into this table, and so it enlists in this transaction
    // via the service's `db` parameter — the membership and its notification
    // commit together or not at all.
    inviteRow = await createNotification({
      recipientId: userId,
      type: "room_invite",
      referenceId: roomId,
      actorId: req.user.id,
      db: client,
    });

    /*
     * Tell the members who were already here. `member_joined` has been
     * allowlisted since it was declared but nothing ever wrote it, so the type
     * existed in the schema and the client's label map and was unreachable in
     * practice.
     *
     * The actor and the newcomer are both excluded: the actor did it, and
     * telling the newcomer they joined a room they were just invited to is
     * noise. createNotification would throw on actor === recipient, so the
     * newcomer has to be filtered out before it is called rather than caught.
     */
    joinedRows = [];
    const existing = await client.query(
      `SELECT user_id
         FROM room_members
        WHERE room_id = $1
          AND user_id <> ALL($2::uuid[])
          AND user_id <> $3`,
      [roomId, [userId, req.user.id], req.user.id],
    );
    for (const member of existing.rows) {
      joinedRows.push(
        await createNotification({
          recipientId: member.user_id,
          type: "member_joined",
          referenceId: roomId,
          actorId: req.user.id,
          db: client,
        }),
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Resolve and push only after the commit. Emitting inside the transaction would
  // tell the invitee about a membership that could still roll back — and this row
  // sat unreachable for the whole of item A, so actually sending it is the point.
  const io = req.app.get("io");
  if (io) {
    const event = { roomId, action: 'joined', userId, actorId: req.user.id };
    io.to(roomId).emit('room:members', event);
    io.to(`user:${userId}`).emit('room:members', event);
  }
  const presented = await presentNotification(inviteRow);
  emitNotification(io, userId, presented);
  for (const row of joinedRows) {
    emitNotification(io, row.recipient_id, await presentNotification(row));
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
// Explicit mark-all-read command. Opening and leaving a timeline do not call
// this endpoint; automatic reads acknowledge individual visible messages.
const markRoomSeen = asyncHandler(async (req, res) => {
  const { roomId } = req.params;

  // An explicit “mark read” command, independent of automatic viewport reads.
  const result = await require('../services/messageReceipt.service').acknowledge({
    roomId, userId: req.user.id, read: true, all: true, io: req.app.get('io'),
  });
  const io = req.app.get('io');
  if (io) io.to(roomId).emit('room-seen', { roomId, userId: req.user.id,
    lastSeenAt: result.last_seen_at, lastSeenSequence: result.last_seen_sequence });
  return ok(res, { roomId, lastSeenAt: result.last_seen_at });
});

// ---------- updateRoom ----------
// Rename a room, or set its description. Admin only.
//
// Whitelist-only, like users.controller updateProfile: only these two fields,
// and an empty body is an error rather than a silent no-op so a client that
// sends the wrong key finds out instead of believing it saved.
//
// `slug` is deliberately not in the list. It is derived server-side (see
// createRoom) and documented in migration 008 as a display handle rather than a
// routing key — rooms are addressed by UUID everywhere — so a rename leaves it
// alone rather than minting a second handle and risking a -2 collision on a
// value nothing links by.
const ROOM_UPDATABLE_FIELDS = ["name", "description", "avatar_url"];
const ROOM_FIELD_LIMITS = { name: 100, description: 1000, avatar_url: 2048 };

const updateRoom = asyncHandler(async (req, res) => {
  const { roomId } = req.params;

  const updates = {};
  for (const field of ROOM_UPDATABLE_FIELDS) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (Object.keys(updates).length === 0) {
    throw new ApiError(
      400,
      `No updatable fields provided. Allowed: ${ROOM_UPDATABLE_FIELDS.join(", ")}`,
    );
  }

  if ("name" in updates && !String(updates.name).trim()) {
    throw new ApiError(400, "name cannot be empty");
  }

  for (const [field, value] of Object.entries(updates)) {
    const limit = ROOM_FIELD_LIMITS[field];
    if (value !== null && String(value).length > limit) {
      throw new ApiError(400, `${field} must be at most ${limit} characters`);
    }
  }

  const check = await query(
    `SELECT
       (SELECT type FROM rooms WHERE id = $1) AS room_type,
       (SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2) AS caller_role`,
    [roomId, req.user.id],
  );
  const { room_type, caller_role } = check.rows[0];

  if (!room_type) throw new ApiError(404, "Room not found");
  if (!caller_role) throw new ApiError(403, "You are not a member of this room");
  if (room_type === 'dm') throw new ApiError(400, 'Direct message details cannot be edited as a room');
  if (caller_role !== "admin") throw new ApiError(403, "Only room admins can edit this room");

  // Column names come from the constant list above; only values are bound.
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [field, value] of Object.entries(updates)) {
    setClauses.push(`${field} = $${i}`);
    values.push(field === "name" ? String(value).trim() : value);
    i += 1;
  }
  values.push(roomId);

  const result = await query(
    `UPDATE rooms SET ${setClauses.join(", ")} WHERE id = $${i}
     RETURNING id, name, description, avatar_url, type, slug`,
    values,
  );

  const io = req.app.get("io");
  if (io) io.to(roomId).emit("room:updated", { roomId, room: result.rows[0], actorId: req.user.id });

  return ok(res, result.rows[0]);
});

// ---------- removeMember ----------
// Removes a member from a room. The caller may remove themselves — that case is
// how a member leaves — or an admin may remove anyone else.
//
// The last-admin guard is the reason this is not a plain DELETE. `role` is only
// ever written at insert time (creator 'admin' at :156, everyone else 'member'
// at :164 and :394), so the creator is permanently the room's only admin until
// setMemberRole exists. Without a guard, an admin removing or demoting themselves
// leaves a room nobody can ever administer again: the one person who could add
// or remove anyone has gone, and there is no way to get them back.
const removeMember = asyncHandler(async (req, res) => {
  const { roomId, userId } = req.params;
  const isSelf = userId === req.user.id;
  const io = req.app.get('io');
  let revocationStarted = false;
  const client = await pool.connect();
  try {
  await client.query('BEGIN');
  const room = await client.query('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
  if (!room.rows.length) throw new ApiError(404, "Room not found");
  const check = await client.query(
    `SELECT
       (SELECT type FROM rooms WHERE id = $1) AS room_type,
       (SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2) AS target_role,
       (SELECT role FROM room_members WHERE room_id = $1 AND user_id = $3) AS caller_role,
       (SELECT COUNT(*)::int FROM room_members WHERE room_id = $1 AND role = 'admin') AS admin_count`,
    [roomId, userId, req.user.id]
  );

  const { room_type, target_role, caller_role, admin_count } = check.rows[0];

  if (!room_type) throw new ApiError(404, "Room not found");
  if (room_type === 'dm') throw new ApiError(409, 'A direct message is a one-to-one conversation and cannot lose a participant');
  // An unknown member and a room you are not in are the same answer: saying
  // "not a member" separately would confirm the id is real to a stranger.
  if (!target_role) throw new ApiError(403, "That user is not a member of this room");
  if (!caller_role) throw new ApiError(403, "You are not a member of this room");

  // Removing yourself needs no privilege. Removing somebody else does, and an
  // admin cannot remove another admin — that is a role change, and routing it
  // through removal would silently skip setMemberRole's last-admin check.
  if (!isSelf && caller_role !== "admin") {
    throw new ApiError(403, "Only room admins can remove members");
  }
  if (!isSelf && target_role === "admin") {
    throw new ApiError(403, "Use the role endpoint to change an admin, not remove");
  }
  if (target_role === "admin" && admin_count <= 1) {
    throw new ApiError(409, "A room must keep at least one admin");
  }

  await client.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [
    roomId,
    userId,
  ]);
  revocationStarted = true;
  await revokeRoomAccess(io, roomId, userId);
  await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (revocationStarted && io) io.to(`user:${userId}`).emit('room:resync', { roomId });
    throw err;
  } finally {
    client.release();
  }

  // After the delete, not inside it: a member removed here is told over the same
  // channel every other membership change goes out on, so an open room in their
  // client does not keep showing them as a member until they refresh.
  if (io) {
    await presence.publishRoomPresence(io, roomId);
    io.to(roomId).emit("room:members", {
      roomId,
      action: isSelf ? "left" : "removed",
      userId,
      actorId: req.user.id,
    });
    // The person removed needs it too, and they are no longer in the room
    // channel to receive a room-scoped emit.
    io.to(`user:${userId}`).emit("room:members", {
      roomId,
      action: isSelf ? "left" : "removed",
      userId,
      actorId: req.user.id,
    });
  }

  return ok(res, { roomId, userId, removed: true });
});

// ---------- setMemberRole ----------
// Grants or revokes admin on a room member.
//
// Promote/demote did not exist before this: `role` was only ever set at insert,
// so the room creator was the sole admin for the life of the room and nobody
// could hand the role on. A member-management screen with no way to change a
// role shows a badge nobody can move.
const setMemberRole = asyncHandler(async (req, res) => {
  const { roomId, userId } = req.params;
  const { role } = req.body;

  if (role !== "admin" && role !== "member") {
    throw new ApiError(400, 'role must be either "admin" or "member"');
  }

  const client = await pool.connect();
  let target_role;
  try {
  await client.query('BEGIN');
  const room = await client.query('SELECT id, type FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
  if (!room.rows.length) throw new ApiError(404, "Room not found");
  if (room.rows[0].type === 'dm') throw new ApiError(409, 'Direct message participants do not have room roles');
  const check = await client.query(
    `SELECT
       (SELECT type FROM rooms WHERE id = $1) AS room_type,
       (SELECT display_name FROM users WHERE id = $2 AND deleted_at IS NULL) AS display_name,
       (SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2) AS target_role,
       (SELECT role FROM room_members WHERE room_id = $1 AND user_id = $3) AS caller_role,
       (SELECT COUNT(*)::int FROM room_members WHERE room_id = $1 AND role = 'admin') AS admin_count`,
    [roomId, userId, req.user.id]
  );

  ({ target_role } = check.rows[0]);
  const { caller_role, admin_count } = check.rows[0];
  if (!target_role) throw new ApiError(403, "That user is not a member of this room");
  if (!caller_role) throw new ApiError(403, "You are not a member of this room");
  if (caller_role !== "admin") throw new ApiError(403, "Only room admins can change roles");

  if (target_role === role) {
    await client.query('COMMIT');
    return ok(res, { roomId, userId, role });
  }

  // Same invariant removeMember protects: a demotion that empties the admin set
  // would leave the room permanently unadministrable.
  if (target_role === "admin" && role === "member" && admin_count <= 1) {
    throw new ApiError(409, "A room must keep at least one admin");
  }

  await client.query('UPDATE room_members SET role = $3 WHERE room_id = $1 AND user_id = $2', [
    roomId,
    userId,
    role,
  ]);
  await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const io = req.app.get("io");
  if (io) io.to(roomId).emit("room:members", { roomId, action: "role", userId, role, actorId: req.user.id });

  return ok(res, { roomId, userId, role });
});

module.exports = {
  createRoom,
  listRooms,
  discoverRooms,
  joinPublicRoom,
  getRoom,
  updateRoom,
  addMember,
  removeMember,
  setMemberRole,
  markRoomSeen,
  updateRoomPreferences,
};
