const { pool, query } = require("../config/db");
const ApiError = require("../utils/ApiError");
const { UUID } = require("../utils/mediaPagination");
const { randomUUID } = require("node:crypto");
const validId = (id) => {
  if (!UUID.test(id || "")) throw new ApiError(400, "Invalid identifier");
  return id;
};
async function member(
  db,
  roomId,
  userId,
  { admin = false, lock = false } = {},
) {
  const row = (
    await db.query(
      `SELECT r.*,rm.role FROM rooms r JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$2 WHERE r.id=$1 ${lock ? "FOR UPDATE OF r" : ""}`,
      [validId(roomId), userId],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "Conversation unavailable");
  if (admin && row.type !== "dm" && row.role !== "admin")
    throw new ApiError(403, "Only admins can change this setting");
  return row;
}
async function visibleMessage(db, id, userId) {
  const row = (
    await db.query(
      "SELECT * FROM messages WHERE id=$1 AND deleted_at IS NULL AND message_visible(id,$2)",
      [validId(id), userId],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "Message unavailable");
  return row;
}
function future(value) {
  const date = new Date(value);
  if (
    !Number.isFinite(+date) ||
    +date < Date.now() + 10000 ||
    +date > Date.now() + 366 * 86400000
  )
    throw new ApiError(
      400,
      "Choose a time between 10 seconds and one year from now",
    );
  return date.toISOString();
}
async function preferences(roomId, userId, values) {
  await member(pool, roomId, userId);
  if (
    !["all", "mentions", "none"].includes(values.level) ||
    !["keep", "off", "hour", "day", "week", "forever"].includes(values.mute)
  )
    throw new ApiError(400, "Choose a notification level and mute duration");
  const until =
    values.mute === "forever"
      ? "9999-12-31T00:00:00Z"
      : ["off", "keep"].includes(values.mute)
        ? null
        : new Date(
            Date.now() +
              { hour: 3600000, day: 86400000, week: 604800000 }[values.mute],
          ).toISOString();
  return (
    await query(
      `INSERT INTO room_member_preferences(room_id,user_id,notification_level,muted,mute_until) VALUES($1,$2,$3,$4,$5) ON CONFLICT(room_id,user_id) DO UPDATE SET notification_level=EXCLUDED.notification_level,muted=CASE WHEN $6 THEN room_member_preferences.muted ELSE EXCLUDED.muted END,mute_until=CASE WHEN $6 THEN room_member_preferences.mute_until ELSE EXCLUDED.mute_until END,updated_at=NOW() RETURNING notification_level,muted,mute_until`,
      [
        roomId,
        userId,
        values.level,
        values.mute === "forever",
        until,
        values.mute === "keep",
      ],
    )
  ).rows[0];
}
async function personalSettings(userId, values) {
  if (
    typeof values.status !== "string" ||
    values.status.length > 100 ||
    !["keep", "off", "hour", "day"].includes(values.dnd)
  )
    throw new ApiError(400, "Invalid status or do-not-disturb duration");
  const until =
    values.dnd === "off"
      ? null
      : new Date(
          Date.now() + (values.dnd === "hour" ? 3600000 : 86400000),
        ).toISOString();
  return (
    await query(
      "UPDATE users SET profile_version=profile_version+1,custom_status=$2,status_until=NOW()+INTERVAL '1 day',dnd_until=CASE WHEN $4 THEN dnd_until ELSE $3::timestamptz END WHERE id=$1 RETURNING custom_status,status_until,dnd_until",
      [userId, values.status.trim(), until, values.dnd === "keep"],
    )
  ).rows[0];
}
async function settings(roomId, userId) {
  const room = await member(pool, roomId, userId);
  const prefs = (
    await query(
      "SELECT notification_level,muted,mute_until FROM room_member_preferences WHERE room_id=$1 AND user_id=$2",
      [roomId, userId],
    )
  ).rows[0] || { notification_level: "all", muted: false, mute_until: null };
  return { ...prefs, disappearing_seconds: room.disappearing_seconds };
}
async function retention(roomId, userId, seconds) {
  if (seconds !== null && ![86400, 604800, 7776000].includes(seconds))
    throw new ApiError(400, "Choose off, 24 hours, 7 days, or 90 days");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const room = await member(db, roomId, userId, { admin: true, lock: true });
    await db.query("UPDATE rooms SET disappearing_seconds=$2 WHERE id=$1", [
      roomId,
      seconds,
    ]);
    await db.query(
      `INSERT INTO room_policy_events(room_id,user_id,seconds) VALUES($1,$2,$3)`,
      [roomId, userId, seconds],
    );
    await db.query("COMMIT");
    return { disappearing_seconds: seconds };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
async function threads(userId, { roomId, before } = {}) {
  if (roomId) await member(pool, roomId, userId);
  if (before && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f-]{36}$/i.test(before))
    throw new ApiError(400, "Invalid thread cursor");
  const split = before?.split("|");
  const rows = (
    await query(
      `SELECT root.id,root.room_id,r.name AS room_name,COUNT(reply.id)::int AS reply_count,MAX(reply.created_at) AS activity_at,MAX(reply.room_sequence)::text AS last_sequence,
 COUNT(reply.id) FILTER(WHERE reply.room_sequence>COALESCE(tr.last_sequence,0) AND reply.sender_id<>$1)::int AS unread_count
 FROM messages root JOIN rooms r ON r.id=root.room_id JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$1
 JOIN messages reply ON reply.thread_root_id=root.id AND reply.deleted_at IS NULL AND message_visible(reply.id,$1)
 LEFT JOIN thread_reads tr ON tr.root_id=root.id AND tr.user_id=$1
 WHERE root.thread_root_id IS NULL AND root.deleted_at IS NULL AND message_visible(root.id,$1) AND ($2::uuid IS NULL OR root.room_id=$2)
 GROUP BY root.id,r.name,tr.last_sequence
 HAVING ($3::timestamptz IS NULL OR (MAX(reply.created_at),root.id)<($3::timestamptz,$4::uuid))
 ORDER BY activity_at DESC,root.id DESC LIMIT 51`,
      [userId, roomId || null, split?.[0] || null, split?.[1] || null],
    )
  ).rows;
  return {
    threads: rows.slice(0, 50),
    nextCursor:
      rows.length > 50
        ? `${new Date(rows[49].activity_at).toISOString()}|${rows[49].id}`
        : null,
  };
}
async function thread(userId, rootId, before) {
  const root = await visibleMessage(pool, rootId, userId);
  if (root.thread_root_id) throw new ApiError(400, "Open the root thread");
  if (
    before !== undefined &&
    (typeof before !== "string" ||
      !/^\d{1,19}$/.test(before) ||
      BigInt(before) > 9223372036854775807n)
  )
    throw new ApiError(400, "Invalid thread cursor");
  const rows = (
    await query(
      "SELECT id,room_sequence FROM messages WHERE thread_root_id=$1 AND deleted_at IS NULL AND message_visible(id,$2) AND ($3::bigint IS NULL OR room_sequence<$3::bigint) ORDER BY room_sequence DESC LIMIT 51",
      [rootId, userId, before || null],
    )
  ).rows;
  const page = await require("./messageSnapshot.service").snapshots(
    root.room_id,
    userId,
    [rootId, ...rows.slice(0, 50).map((r) => r.id)],
  );
  return {
    ...page,
    rootId,
    roomId: root.room_id,
    nextCursor: rows.length > 50 ? rows[49].room_sequence : null,
  };
}
async function readThread(userId, rootId, sequence) {
  const root = await visibleMessage(pool, rootId, userId);
  if (
    !/^\d{1,19}$/.test(String(sequence)) ||
    BigInt(sequence) > 9223372036854775807n
  )
    throw new ApiError(400, "Invalid thread position");
  const latest = (
    await query(
      "SELECT COALESCE(MAX(room_sequence),0)::text AS sequence FROM messages WHERE thread_root_id=$1 AND message_visible(id,$2)",
      [rootId, userId],
    )
  ).rows[0].sequence;
  const capped = BigInt(sequence) < BigInt(latest) ? String(sequence) : latest;
  await query(
    "INSERT INTO thread_reads(root_id,user_id,last_sequence) VALUES($1,$2,$3) ON CONFLICT(root_id,user_id) DO UPDATE SET last_sequence=GREATEST(thread_reads.last_sequence,EXCLUDED.last_sequence)",
    [rootId, userId, capped],
  );
  return { rootId, sequence: capped };
}
async function saved(userId, before) {
  if (before && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f-]{36}$/i.test(before))
    throw new ApiError(400, "Invalid bookmark cursor");
  const split = before?.split("|");
  const rows = (
    await query(
      `SELECT m.id,m.room_id,m.created_at,p.pinned_at FROM message_pins p JOIN messages m ON m.id=p.message_id WHERE p.scope='user' AND p.user_id=$1 AND message_visible(m.id,$1) AND m.deleted_at IS NULL AND ($2::timestamptz IS NULL OR (p.pinned_at,m.id)<($2::timestamptz,$3::uuid)) ORDER BY p.pinned_at DESC,m.id DESC LIMIT 51`,
      [userId, split?.[0] || null, split?.[1] || null],
    )
  ).rows;
  const messages = [];
  for (const roomId of new Set(rows.slice(0, 50).map((r) => r.room_id))) {
    messages.push(
      ...(
        await require("./messageSnapshot.service").snapshots(
          roomId,
          userId,
          rows
            .slice(0, 50)
            .filter((r) => r.room_id === roomId)
            .map((r) => r.id),
        )
      ).messages,
    );
  }
  const order = new Map(rows.map((r, i) => [r.id, i]));
  messages.sort((a, b) => order.get(a.id) - order.get(b.id));
  return {
    messages,
    nextCursor:
      rows.length > 50
        ? `${new Date(rows[49].pinned_at).toISOString()}|${rows[49].id}`
        : null,
  };
}
async function personalRoom(userId) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    let room = (
      await db.query("SELECT id FROM rooms WHERE personal_for=$1", [userId])
    ).rows[0];
    if (!room) {
      room = (
        await db.query(
          "INSERT INTO rooms(name,type,created_by,encryption_mode,personal_for,slug) VALUES('Saved messages','private',$1,'e2ee-v1',$1,$2) RETURNING id",
          [userId, `saved-${userId}`],
        )
      ).rows[0];
      await db.query(
        "INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,'admin')",
        [room.id, userId],
      );
    }
    await db.query("COMMIT");
    return room;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
async function remind(userId, messageId, due) {
  const source = await visibleMessage(pool, messageId, userId);
  if (source.expires_at && new Date(future(due)) >= new Date(source.expires_at))
    throw new ApiError(400, "Set the reminder before this message expires");
  if (
    (
      await query(
        "SELECT 1 FROM message_reminders WHERE user_id=$1 AND completed_at IS NULL AND cancelled_at IS NULL LIMIT 200",
        [userId],
      )
    ).rowCount >= 200
  )
    throw new ApiError(409, "Complete or cancel a reminder first");
  return (
    await query(
      "INSERT INTO message_reminders(user_id,message_id,due_at) VALUES($1,$2,$3) RETURNING id,due_at",
      [userId, messageId, future(due)],
    )
  ).rows[0];
}
async function schedule(userId, roomId, payload, due, reviewId) {
  const room = await member(pool, roomId, userId);
  let sealed = null;
  if (room.superseded_by)
    throw new ApiError(409, "Use the current conversation");
  if (
    !payload ||
    !UUID.test(payload.clientId || "") ||
    payload.roomId !== roomId ||
    payload.attachments?.length ||
    payload.forwardSource
  )
    throw new ApiError(400, "Schedule a text message only");
  if (room.encryption_mode === "e2ee-v1") {
    if (payload.content)
      throw new ApiError(
        400,
        "Encrypt this message on your device before scheduling",
      );
    sealed = await require("./encryption.service").validateMessage(
      pool,
      roomId,
      userId,
      payload.clientId,
      payload.encryptedPayload,
    );
  } else if (
    typeof payload.content !== "string" ||
    !payload.content.trim() ||
    payload.content.length > 20000 ||
    payload.encryptedPayload
  )
    throw new ApiError(400, "Invalid scheduled text");
  if (
    !reviewId &&
    (
      await query(
        "SELECT 1 FROM scheduled_messages WHERE user_id=$1 AND status IN('pending','sending','needs_review') LIMIT 100",
        [userId],
      )
    ).rowCount >= 100
  )
    throw new ApiError(409, "Send or cancel an existing schedule first");
  const safe = {
    roomId,
    clientId: payload.clientId,
    ...(room.encryption_mode === "e2ee-v1"
      ? { encryptedPayload: sealed }
      : { content: payload.content }),
    ...(payload.threadRootId
      ? { threadRootId: validId(payload.threadRootId) }
      : {}),
  };
  if (reviewId) {
    validId(reviewId);
    const result = (
      await query(
        "UPDATE scheduled_messages SET payload=$3,due_at=$4,status='pending',reason=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='needs_review' AND room_id=$5 AND client_id=$6 RETURNING id,status,due_at",
        [reviewId, userId, safe, future(due), roomId, payload.clientId],
      )
    ).rows[0];
    if (!result)
      throw new ApiError(409, "This schedule no longer needs review");
    return result;
  }
  return (
    await query(
      "INSERT INTO scheduled_messages(user_id,room_id,client_id,payload,due_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,client_id) DO UPDATE SET updated_at=scheduled_messages.updated_at RETURNING id,status,due_at",
      [userId, roomId, payload.clientId, safe, future(due)],
    )
  ).rows[0];
}
module.exports = {
  member,
  visibleMessage,
  validId,
  future,
  preferences,
  personalSettings,
  settings,
  retention,
  threads,
  thread,
  readThread,
  saved,
  personalRoom,
  remind,
  schedule,
};
