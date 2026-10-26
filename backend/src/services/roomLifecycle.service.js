const crypto = require("node:crypto");
const { pool, query } = require("../config/db");
const ApiError = require("../utils/ApiError");
const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");
async function locked(roomId, userId, work, { admin = false } = {}) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const room = (
      await db.query("SELECT * FROM rooms WHERE id=$1 FOR UPDATE", [roomId])
    ).rows[0];
    const member = (
      await db.query(
        "SELECT * FROM room_members WHERE room_id=$1 AND user_id=$2",
        [roomId, userId],
      )
    ).rows[0];
    if (!room || !member) throw new ApiError(404, "Conversation not found");
    if (admin && (room.type === "dm" || member.role !== "admin"))
      throw new ApiError(403, "Only room admins can manage this action");
    const result = await work(db, room, member);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
async function state(roomId, userId) {
  return locked(roomId, userId, async (db, room, member) => ({
    join_approval: room.join_approval,
    member_can_send: room.member_can_send,
    member_can_invite: room.member_can_invite,
    encryption_mode: room.encryption_mode,
    cleared_sequence: member.cleared_sequence,
    cleared_at: member.cleared_at,
    preferences: (
      await db.query(
        "SELECT pinned,(muted OR COALESCE(mute_until>NOW(),FALSE) OR notification_level='none') AS muted,archived FROM room_member_preferences WHERE room_id=$1 AND user_id=$2",
        [roomId, userId],
      )
    ).rows[0] || { pinned: false, muted: false, archived: false },
    invites:
      member.role === "admin"
        ? (
            await db.query(
              "SELECT id,expires_at,max_uses,uses,revoked_at,created_at FROM room_invites WHERE room_id=$1 ORDER BY (revoked_at IS NULL AND expires_at>NOW() AND uses<max_uses) DESC, created_at DESC LIMIT 50",
              [roomId],
            )
          ).rows
        : [],
    requests:
      member.role === "admin"
        ? (
            await db.query(
              "SELECT j.user_id,j.created_at,u.display_name FROM room_join_requests j JOIN users u ON u.id=j.user_id WHERE j.room_id=$1 AND j.status='pending' AND u.deleted_at IS NULL ORDER BY j.created_at LIMIT 100",
              [roomId],
            )
          ).rows
        : [],
    storage: (
      await db.query(
        `SELECT COUNT(*)::int AS attachment_count,COALESCE(SUM(a.size_bytes),0)::text AS bytes FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.room_id=$1 AND m.deleted_at IS NULL AND message_visible(m.id,$2)`,
        [roomId, userId],
      )
    ).rows[0],
  }));
}
async function settings(roomId, userId, values) {
  const allowed = ["join_approval", "member_can_send", "member_can_invite"],
    keys = Object.keys(values || {});
  if (
    !keys.length ||
    keys.some((k) => !allowed.includes(k) || typeof values[k] !== "boolean")
  )
    throw new ApiError(400, "Provide supported room settings as booleans");
  return locked(
    roomId,
    userId,
    async (db) =>
      (
        await db.query(
          `UPDATE rooms SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(",")} WHERE id=$1 RETURNING join_approval,member_can_send,member_can_invite`,
          [roomId, ...keys.map((k) => values[k])],
        )
      ).rows[0],
    { admin: true },
  );
}
async function invite(roomId, userId, values) {
  const hours = values?.expiresInHours ?? 168,
    maxUses = values?.maxUses ?? 100;
  if (
    !Number.isInteger(hours) ||
    hours < 1 ||
    hours > 720 ||
    !Number.isInteger(maxUses) ||
    maxUses < 1 ||
    maxUses > 10000
  )
    throw new ApiError(400, "Use 1–720 expiry hours and 1–10000 uses");
  return locked(roomId, userId, async (db, room, member) => {
    if (
      room.type === "dm" ||
      room.personal_for ||
      (member.role !== "admin" && !room.member_can_invite)
    )
      throw new ApiError(403, "You cannot create room invitations");
    if (
      (
        await db.query(
          "SELECT COUNT(*)::int AS n FROM room_invites WHERE room_id=$1 AND revoked_at IS NULL AND expires_at>NOW() AND uses<max_uses",
          [roomId],
        )
      ).rows[0].n >= 50
    )
      throw new ApiError(
        409,
        "Revoke an active invitation before creating another",
      );
    const token = crypto.randomBytes(32).toString("base64url");
    const row = (
      await db.query(
        "INSERT INTO room_invites(room_id,token_hash,created_by,expires_at,max_uses) VALUES($1,$2,$3,NOW()+($4::int*INTERVAL '1 hour'),$5) RETURNING id,expires_at,max_uses",
        [roomId, hash(token), userId, hours, maxUses],
      )
    ).rows[0];
    return { ...row, token };
  });
}
async function revoke(roomId, userId, inviteId) {
  return locked(
    roomId,
    userId,
    async (db) => {
      const row = await db.query(
        "UPDATE room_invites SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1 AND room_id=$2 RETURNING id",
        [inviteId, roomId],
      );
      if (!row.rowCount) throw new ApiError(404, "Invitation not found");
      return { revoked: true };
    },
    { admin: true },
  );
}
async function ready(db, room, userId) {
  if (
    !(
      await db.query("SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL", [
        userId,
      ])
    ).rowCount
  )
    throw new ApiError(409, "This account is no longer active");
  if (
    room.encryption_mode === "e2ee-v1" &&
    !(
      await db.query(
        `SELECT 1 FROM encryption_devices d JOIN auth_sessions s ON s.id=d.session_id WHERE d.user_id=$1 AND d.approved_at IS NOT NULL AND d.revoked_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>NOW() LIMIT 1`,
        [userId],
      )
    ).rowCount
  )
    throw new ApiError(
      409,
      "Set up an approved encryption device in Settings before joining",
    );
}
async function enter({ roomId, token, userId }) {
  if (
    token !== undefined &&
    (typeof token !== "string" || !/^[-\w]{43}$/.test(token))
  )
    throw new ApiError(404, "Invitation is invalid or expired");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    if (token) {
      const found = (
        await db.query("SELECT room_id FROM room_invites WHERE token_hash=$1", [
          hash(token),
        ])
      ).rows[0];
      if (!found) throw new ApiError(404, "Invitation is invalid or expired");
      roomId = found.room_id;
    }
    const room = (
      await db.query("SELECT * FROM rooms WHERE id=$1 FOR UPDATE", [roomId])
    ).rows[0];
    if (!room || room.type === "dm" || room.personal_for || room.superseded_by)
      throw new ApiError(404, "Room is not available to join");
    let link;
    if (token) {
      link = (
        await db.query(
          "SELECT * FROM room_invites WHERE token_hash=$1 AND room_id=$2 FOR UPDATE",
          [hash(token), roomId],
        )
      ).rows[0];
      if (
        !link ||
        link.revoked_at ||
        new Date(link.expires_at) <= new Date() ||
        link.uses >= link.max_uses
      )
        throw new ApiError(404, "Invitation is invalid or expired");
    } else if (room.type !== "public")
      throw new ApiError(403, "An invitation is required");
    const existing = (
      await db.query(
        "SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2",
        [roomId, userId],
      )
    ).rowCount;
    if (existing) {
      await db.query("COMMIT");
      return { roomId, status: "joined" };
    }
    await ready(db, room, userId);
    if (room.join_approval) {
      await db.query(
        `INSERT INTO room_join_requests(room_id,user_id,invite_id) VALUES($1,$2,$3) ON CONFLICT(room_id,user_id) DO UPDATE SET status='pending',invite_id=EXCLUDED.invite_id,updated_at=NOW()`,
        [roomId, userId, link?.id || null],
      );
      await db.query("COMMIT");
      return { roomId, status: "pending" };
    }
    await db.query(
      "INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",
      [roomId, userId],
    );
    await db.query(
      "UPDATE room_join_requests SET status='approved',updated_at=NOW() WHERE room_id=$1 AND user_id=$2 AND status='pending'",
      [roomId, userId],
    );
    if (link)
      await db.query("UPDATE room_invites SET uses=uses+1 WHERE id=$1", [
        link.id,
      ]);
    await db.query("COMMIT");
    return { roomId, status: "joined" };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
async function review(roomId, adminId, userId, decision) {
  if (!["approved", "rejected"].includes(decision))
    throw new ApiError(400, "Choose approved or rejected");
  return locked(
    roomId,
    adminId,
    async (db, room) => {
      const request = (
        await db.query(
          "SELECT * FROM room_join_requests WHERE room_id=$1 AND user_id=$2 AND status='pending' FOR UPDATE",
          [roomId, userId],
        )
      ).rows[0];
      if (!request) throw new ApiError(404, "Pending request not found");
      if (decision === "approved") {
        await ready(db, room, userId);
        if (request.invite_id) {
          const invite = (
            await db.query(
              "SELECT * FROM room_invites WHERE id=$1 FOR UPDATE",
              [request.invite_id],
            )
          ).rows[0];
          if (
            !invite ||
            invite.revoked_at ||
            new Date(invite.expires_at) <= new Date() ||
            invite.uses >= invite.max_uses
          )
            throw new ApiError(
              409,
              "Invitation expired, revoked, or exhausted",
            );
          await db.query("UPDATE room_invites SET uses=uses+1 WHERE id=$1", [
            invite.id,
          ]);
        } else if (room.type !== "public")
          throw new ApiError(409, "A valid invitation is required");
        await db.query(
          "INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",
          [roomId, userId],
        );
      }
      await db.query(
        "UPDATE room_join_requests SET status=$3,reviewed_by=$4,updated_at=NOW() WHERE room_id=$1 AND user_id=$2",
        [roomId, userId, decision, adminId],
      );
      return { roomId, userId, status: decision };
    },
    { admin: true },
  );
}
async function handover(roomId, userId, successorId) {
  if (userId === successorId)
    throw new ApiError(400, "Choose another participant");
  return locked(
    roomId,
    userId,
    async (db) => {
      if (
        !(
          await db.query(
            "SELECT 1 FROM room_members rm JOIN users u ON u.id=rm.user_id WHERE rm.room_id=$1 AND rm.user_id=$2 AND u.deleted_at IS NULL",
            [roomId, successorId],
          )
        ).rowCount
      )
        throw new ApiError(404, "Successor must be an active participant");
      await db.query(
        "UPDATE room_members SET role=CASE WHEN user_id=$2 THEN 'admin' ELSE 'member' END WHERE room_id=$1 AND user_id=ANY($3::uuid[])",
        [roomId, successorId, [userId, successorId]],
      );
      return { roomId, successorId };
    },
    { admin: true },
  );
}
async function clear(roomId, userId, { hide = false } = {}) {
  return locked(roomId, userId, async (db, room) => {
    await db.query(
      "INSERT INTO room_personal_history(room_id,user_id,cleared_sequence) VALUES($1,$2,$3) ON CONFLICT(room_id,user_id) DO UPDATE SET cleared_sequence=GREATEST(room_personal_history.cleared_sequence,EXCLUDED.cleared_sequence),cleared_at=NOW()",
      [roomId, userId, room.message_sequence],
    );
    const row = (
      await db.query(
        "UPDATE room_members SET cleared_sequence=GREATEST(cleared_sequence,$3::bigint),cleared_at=NOW() WHERE room_id=$1 AND user_id=$2 RETURNING cleared_sequence,cleared_at",
        [roomId, userId, room.message_sequence],
      )
    ).rows[0];
    await db.query(
      `UPDATE notifications SET seen=TRUE WHERE recipient_id=$1 AND reference_id IN(SELECT id FROM messages WHERE room_id=$2 AND room_sequence<=$3)`,
      [userId, roomId, row.cleared_sequence],
    );
    if (hide)
      await db.query(
        "INSERT INTO room_member_preferences(room_id,user_id,hidden_sequence) VALUES($1,$2,$3) ON CONFLICT(room_id,user_id) DO UPDATE SET hidden_sequence=EXCLUDED.hidden_sequence,updated_at=NOW()",
        [roomId, userId, row.cleared_sequence],
      );
    return { roomId, ...row };
  });
}
module.exports = {
  locked,
  state,
  settings,
  invite,
  revoke,
  enter,
  review,
  handover,
  clear,
};

async function invitationStatus(userId, token) {
  if (typeof token !== "string" || !/^[-\w]{43}$/.test(token))
    throw new ApiError(404, "Invitation is invalid or expired");
  const row = (
    await query(
      `SELECT i.room_id,i.revoked_at,i.expires_at,i.uses,i.max_uses,
 EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=i.room_id AND rm.user_id=$2) AS member,
 (SELECT status FROM room_join_requests j WHERE j.room_id=i.room_id AND j.user_id=$2) AS request
 FROM room_invites i WHERE token_hash=$1`,
      [hash(token), userId],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "Invitation is invalid or expired");
  if (row.member) return { status: "joined", roomId: row.room_id };
  if (
    row.revoked_at ||
    new Date(row.expires_at) <= new Date() ||
    row.uses >= row.max_uses
  )
    throw new ApiError(404, "Invitation is invalid or expired");
  return { status: row.request || "available" };
}
module.exports.invitationStatus = invitationStatus;
