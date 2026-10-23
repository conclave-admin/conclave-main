const { query } = require("../config/db");
const ApiError = require("../utils/ApiError");

const defaults = Object.freeze({
  online_visibility: "everyone",
  last_seen_visibility: "connections",
  photo_visibility: "everyone",
  about_visibility: "connections",
  read_receipts: true,
  dm_policy: "requests",
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function get(userId) {
  const result = await query(
    "SELECT * FROM privacy_preferences WHERE user_id=$1",
    [userId],
  );
  return { ...defaults, ...result.rows[0] };
}
async function update(userId, values, io) {
  const fields = Object.keys(values || {});
  if (!fields.length || fields.some((key) => !Object.hasOwn(defaults, key)))
    throw new ApiError(400, "Provide supported privacy settings");
  for (const field of fields) {
    const allowed =
      field === "dm_policy"
        ? ["everyone", "requests", "connections", "nobody"]
        : ["everyone", "connections", "nobody"];
    if (
      field === "read_receipts"
        ? typeof values[field] !== "boolean"
        : !allowed.includes(values[field])
    )
      throw new ApiError(400, `Invalid ${field}`);
  }
  await query(
    `INSERT INTO privacy_preferences(user_id,${fields.join(",")}) VALUES($1,${fields.map((_, i) => `$${i + 2}`).join(",")})
    ON CONFLICT(user_id) DO UPDATE SET ${fields.map((field) => `${field}=EXCLUDED.${field}`).join(",")}`,
    [userId, ...fields.map((field) => values[field])],
  );
  if ("read_receipts" in values)
    await query(
      "UPDATE messages SET receipt_version=receipt_version+1 WHERE room_id IN(SELECT r.id FROM rooms r JOIN room_members rm ON rm.room_id=r.id WHERE rm.user_id=$1 AND r.type='dm')",
      [userId],
    );
  if (io) {
    const rooms = await query(
      "SELECT room_id FROM room_members WHERE user_id=$1",
      [userId],
    );
    for (const { room_id } of rooms.rows) {
      io.to(room_id).emit("privacy:changed", { userId, hidden: false });
      await require("./presence.service").publishRoomPresence(io, room_id);
    }
  }
  return get(userId);
}

// One batched presentation policy for API payloads and personalized socket data.
// Names stay visible for attribution; email is never a public profile field.
async function present(data, viewerId, db = { query }) {
  if (!viewerId || !data || typeof data !== "object") return data;
  const ids = new Set();
  const visit = (value, fn) => {
    if (!value || typeof value !== "object" || value instanceof Date) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, fn));
      return;
    }
    fn(value);
    Object.values(value).forEach((item) => visit(item, fn));
  };
  visit(data, (row) => {
    if (("avatar_url" in row || "bio" in row) && uuid.test(row.id || ""))
      ids.add(row.id);
    if ("sender_avatar" in row && uuid.test(row.sender_id || ""))
      ids.add(row.sender_id);
  });
  if (!ids.size) return data;
  const policy = await db.query(
    `SELECT u.id,privacy_allowed(u.id,$2,'photo') AS photo,privacy_allowed(u.id,$2,'about') AS about
    FROM users u WHERE u.id=ANY($1::uuid[])`,
    [[...ids], viewerId],
  );
  const permissions = new Map(policy.rows.map((row) => [row.id, row]));
  // Copy JSON payloads so one viewer's redaction cannot affect another viewer.
  const copy = structuredClone(data);
  visit(copy, (row) => {
    if (
      "avatar_url" in row &&
      permissions.has(row.id) &&
      !permissions.get(row.id).photo
    )
      row.avatar_url = null;
    if (
      "bio" in row &&
      permissions.has(row.id) &&
      !permissions.get(row.id).about
    )
      row.bio = null;
    if (
      "sender_avatar" in row &&
      permissions.has(row.sender_id) &&
      !permissions.get(row.sender_id).photo
    )
      row.sender_avatar = null;
  });
  return copy;
}
async function emitMessage(io, roomId, event, message) {
  const members = await query(
    "SELECT user_id FROM room_members WHERE room_id=$1",
    [roomId],
  );
  for (const { user_id } of members.rows) {
    const payload = await present(message, user_id);
    io.to(`user:${user_id}`).emit(event, { message: payload });
  }
}
async function assertCanStartDm(db, senderId, recipientId) {
  const result = await db.query(
    `SELECT COALESCE(p.dm_policy,'requests') AS policy,privacy_connected($2,$1) AS connected
    FROM users u LEFT JOIN privacy_preferences p ON p.user_id=u.id WHERE u.id=$2`,
    [senderId, recipientId],
  );
  const policy = result.rows[0];
  if (
    !policy ||
    policy.policy === "nobody" ||
    (policy.policy === "connections" && !policy.connected)
  )
    throw new ApiError(403, "This person is not accepting new direct messages");
  return policy.policy === "requests" && !policy.connected;
}
async function assertCanSendDm(db, roomId, senderId) {
  const row = (
    await db.query("SELECT * FROM dm_requests WHERE room_id=$1", [roomId])
  ).rows[0];
  if (!row || row.status === "accepted") return;
  if (row.status === "declined" || row.recipient_id === senderId)
    throw new ApiError(403, "Accept this message request before replying");
  if (
    (
      await db.query(
        "SELECT 1 FROM messages WHERE room_id=$1 AND sender_id=$2 AND deleted_at IS NULL LIMIT 1",
        [roomId, senderId],
      )
    ).rowCount
  )
    throw new ApiError(
      403,
      "Wait for this person to accept your message request",
    );
}
module.exports = {
  defaults,
  get,
  update,
  present,
  emitMessage,
  assertCanStartDm,
  assertCanSendDm,
};
