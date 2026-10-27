const { query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const ApiError = require("../utils/ApiError");

// Catch-up Digest — per-room summary since the user's last visit:
// new decisions, mentions, files, and high-activity messages.
//
// v1 (MVP): rule-based. Query everything created after the caller's
// room_members.last_seen_at — new decisions, new/updated tasks, messages
// that @-mention them, new attachments — and return counts + lists.
//
// v2: hand that same query result to the Claude API as context and ask
// for a short narrative summary instead of a raw list.

// Mentions come from the message_mentions table (BACKEND_TASKS.md item H), not
// from matching display names against message text. The name matcher is still
// used by createMessage as a temporary fallback for clients that send no
// mentionedUserIds — see services/mention.service.js.

// ---------- getRoomDigest ----------
// Per-room digest: everything new since the user's last visit
const getRoomDigest = asyncHandler(async (req, res) => {
  const { roomId } = req.params;

  // 1. Verify membership and get the digest pointer.
  //
  // digest_seen_at rather than last_seen_at: this endpoint used to filter on
  // the read receipt, so opening the room advanced the pointer and a digest
  // fetched afterwards found nothing — which is why the in-room catch-up card
  // was removed in phase 6 and could not simply be reinstated here.
  const membership = await query(
    `SELECT rm.digest_seen_at, r.name AS room_name
     FROM room_members rm
     INNER JOIN rooms r ON r.id = rm.room_id
     WHERE rm.room_id = $1 AND rm.user_id = $2`,
    [roomId, req.user.id],
  );
  if (membership.rows.length === 0) {
    throw new ApiError(403, "You are not a member of this room");
  }
  const lastSeenAt = membership.rows[0].digest_seen_at;
  const roomName = membership.rows[0].room_name;

  // 2. New decisions since last visit
  const decisions = await query(
    `SELECT d.id, d.title, d.body, d.tags, dr.changed_at AS created_at,
            dr.status, dr.version, u.display_name AS author_name
     FROM decisions d
     INNER JOIN LATERAL (
       SELECT changed_at, changed_by, status, version FROM decision_revisions
       WHERE decision_id=d.id AND changed_at > $2 ORDER BY version DESC LIMIT 1
     ) dr ON TRUE
     INNER JOIN users u ON u.id = dr.changed_by
     WHERE d.room_id = $1
     ORDER BY dr.changed_at DESC`,
    [roomId, lastSeenAt],
  );

  // 3. Tasks assigned to me that were updated since last visit
  const tasks = await query(
    `SELECT t.id, t.title, t.status, t.due_date, t.updated_at, u.display_name AS assignee_name
     FROM tasks t
     INNER JOIN users u ON u.id = t.assignee_id
     WHERE t.room_id = $1 AND t.assignee_id = $2 AND t.updated_at > $3
     ORDER BY t.updated_at DESC`,
    [roomId, req.user.id, lastSeenAt],
  );

  // 4. Messages that @-mention me since last visit.
  //
  // Joined on message_mentions rather than matched against the message text
  // (BACKEND_TASKS.md item H). Deliberately no text fallback: a message sent by a
  // client predating structured mentions simply has no rows and does not appear,
  // whereas re-deriving mentions from text here would reintroduce the exact
  // rename bug item H removes — on historical rows, where it matters most, because
  // a name may have changed since those messages were written.
  const mentions = await query(
    `SELECT m.id, m.content, m.created_at, u.display_name AS sender_name
     FROM message_mentions mm
     INNER JOIN messages m ON m.id = mm.message_id
     INNER JOIN users u ON u.id = m.sender_id
     WHERE m.room_id = $1 AND message_visible(m.id,$3)
       AND m.created_at > $2
       AND mm.user_id = $3
       AND m.sender_id != $3
       AND m.deleted_at IS NULL
     ORDER BY m.room_sequence DESC
     LIMIT 20`,
    [roomId, lastSeenAt, req.user.id],
  );

  // 5. New attachments since last visit
  const files = await query(
    `SELECT a.id, a.filename, a.file_type, a.size_bytes, a.created_at,
            m.content AS message_content, u.display_name AS sender_name
     FROM attachments a
     INNER JOIN messages m ON m.id = a.message_id
     INNER JOIN users u ON u.id = m.sender_id
     WHERE m.room_id = $1 AND message_visible(m.id,$3) AND a.created_at > $2
       AND m.deleted_at IS NULL
     ORDER BY a.created_at DESC
     LIMIT 20`,
    [roomId, lastSeenAt, req.user.id],
  );

  // 6. Activity count (total new messages since the digest was last marked).
  //
  // deleted_at IS NULL because the cross-room query has it and this one did
  // not, so the two endpoints counted different things: a retracted message
  // showed up as activity here and not there.
  //
  // MAX(created_at) is carried out so the item can be stamped with when the room
  // was actually active. It was stamped with the digest pointer instead, which
  // is a constant for every room and floated every active room to the top of a
  // sorted list.
  const activity = await query(
    `SELECT COUNT(*)::int AS message_count, MAX(created_at) AS last_activity_at
     FROM messages
     WHERE room_id = $1 AND created_at > $2 AND deleted_at IS NULL AND message_visible(id,$3)`,
    [roomId, lastSeenAt, req.user.id],
  );

  const items = [
    ...decisions.rows.map((d) => ({
      id: d.id,
      type: "decision",
      title: `${d.version === 1 ? "Recorded" : d.status === "retracted" ? "Retracted" : "Updated"}: ${d.title}`,
      metadata: d.author_name,
      room_id: roomId,
      room_name: roomName,
      created_at: d.created_at,
    })),
    ...tasks.rows.map((t) => ({
      id: t.id,
      type: "task",
      title: t.title,
      metadata: `${t.status} · ${t.assignee_name}`,
      room_id: roomId,
      room_name: roomName,
      created_at: t.updated_at,
    })),
    ...mentions.rows.map((m) => ({
      id: m.id,
      type: "mention",
      title: m.content,
      metadata: m.sender_name,
      room_id: roomId,
      room_name: roomName,
      created_at: m.created_at,
    })),
    ...files.rows.map((f) => ({
      id: f.id,
      type: "file",
      title: f.filename,
      metadata: f.sender_name,
      room_id: roomId,
      room_name: roomName,
      created_at: f.created_at,
    })),
    ...(activity.rows[0].message_count > 0
      ? [
          {
            id: `activity-${roomId}`,
            type: "activity",
            title: `${activity.rows[0].message_count} new messages`,
            metadata: null,
            room_id: roomId,
            room_name: roomName,
            created_at: activity.rows[0].last_activity_at,
          },
        ]
      : []),
  ];

  // Sort by created_at descending
  items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return ok(res, {
    items,
    summary: {
      headline: `${items.length} meaningful updates`,
      summary: `${decisions.rows.length} decisions, ${tasks.rows.length} task changes, ${mentions.rows.length} mentions, ${files.rows.length} files.`,
    },
  });
});

// ---------- getUserDigest ----------
// Cross-room: aggregate digest across all rooms the user is in
const getUserDigest = asyncHandler(async (req, res) => {
  const rooms = await query(
    `SELECT room_id FROM room_members WHERE user_id = $1`,
    [req.user.id],
  );

  const roomIds = rooms.rows.map((r) => r.room_id);
  if (roomIds.length === 0) {
    return ok(res, {
      items: [],
      summary: { headline: "No updates", summary: "You are not in any rooms." },
    });
  }

  // Every category below joins room_members on (room_id, user_id) and filters
  // against that row's own digest_seen_at. A single shared timestamp would be
  // wrong: the pointer is per room, so a user who read #design-crit this morning
  // but not #marketing since last week must see the marketing backlog and not
  // the design one. See BACKEND_TASKS.md Bug 2.
  //
  // digest_seen_at and not last_seen_at, deliberately. The digest used to filter
  // on the read receipt, which meant opening a room — advancing last_seen_at to
  // NOW() — erased the very backlog it was reporting on. Migration 018 splits
  // them: reading advances the receipt, marking the digest read advances this.

  // 1. New decisions across all rooms
  const decisions = await query(
    `SELECT d.id, d.title, d.body, d.tags, dr.changed_at AS created_at,
            dr.status, dr.version, d.room_id,
            r.name AS room_name, u.display_name AS author_name
     FROM decisions d
     INNER JOIN rooms r ON r.id = d.room_id
     INNER JOIN room_members rm ON rm.room_id = d.room_id AND rm.user_id = $2
     INNER JOIN LATERAL (
       SELECT changed_at, changed_by, status, version FROM decision_revisions
       WHERE decision_id=d.id AND changed_at > rm.digest_seen_at
       ORDER BY version DESC LIMIT 1
     ) dr ON TRUE
     INNER JOIN users u ON u.id = dr.changed_by
     WHERE d.room_id = ANY($1)
     ORDER BY dr.changed_at DESC
     LIMIT 50`,
    [roomIds, req.user.id],
  );

  // 2. Tasks assigned to me that were updated
  const tasks = await query(
    `SELECT t.id, t.title, t.status, t.due_date, t.updated_at, t.room_id,
            r.name AS room_name, u.display_name AS assignee_name
     FROM tasks t
     INNER JOIN rooms r ON r.id = t.room_id
     INNER JOIN users u ON u.id = t.assignee_id
     INNER JOIN room_members rm ON rm.room_id = t.room_id AND rm.user_id = $2
     WHERE t.room_id = ANY($1)
       AND t.assignee_id = $2
       AND t.updated_at > rm.digest_seen_at
     ORDER BY t.updated_at DESC
     LIMIT 50`,
    [roomIds, req.user.id],
  );

  // 3. Messages that @-mention me.
  //
  // Same message_mentions join as the per-room digest, and the same deliberate
  // absence of a text fallback.
  const mentions = await query(
    `SELECT m.id, m.content, m.created_at, m.room_id,
            r.name AS room_name, u.display_name AS sender_name
     FROM message_mentions mm
     INNER JOIN messages m ON m.id = mm.message_id
     INNER JOIN rooms r ON r.id = m.room_id
     INNER JOIN users u ON u.id = m.sender_id
     INNER JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
     WHERE m.room_id = ANY($1) AND message_visible(m.id,$2)
       AND mm.user_id = $2
       AND m.sender_id != $2
       AND m.deleted_at IS NULL
       AND m.created_at > rm.digest_seen_at
     ORDER BY m.room_sequence DESC
     LIMIT 50`,
    [roomIds, req.user.id],
  );

  // 4. New attachments
  const files = await query(
    `SELECT a.id, a.filename, a.file_type, a.size_bytes, a.created_at,
            m.room_id, r.name AS room_name, u.display_name AS sender_name
     FROM attachments a
     INNER JOIN messages m ON m.id = a.message_id
     INNER JOIN rooms r ON r.id = m.room_id
     INNER JOIN users u ON u.id = m.sender_id
     INNER JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
     WHERE m.room_id = ANY($1) AND message_visible(m.id,$2)
       AND a.created_at > rm.digest_seen_at
     ORDER BY a.created_at DESC
     LIMIT 50`,
    [roomIds, req.user.id],
  );

  // 5. Activity per room, counting only messages newer than that room's
  //    last_seen_at. last_activity_at is carried through so activity items
  //    sort by when the room was actually active — stamping them with
  //    new Date() made every room's activity float to the top of the digest.
  const activity = await query(
    `SELECT m.room_id,
            r.name AS room_name,
            COUNT(*)::int AS message_count,
            MAX(m.created_at) AS last_activity_at
     FROM messages m
     INNER JOIN rooms r ON r.id = m.room_id
     INNER JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
     WHERE m.room_id = ANY($1) AND message_visible(m.id,$2)
       AND m.created_at > rm.digest_seen_at
       AND m.deleted_at IS NULL
     GROUP BY m.room_id, r.name`,
    [roomIds, req.user.id],
  );

  const items = [
    ...decisions.rows.map((d) => ({
      id: d.id,
      type: "decision",
      title: `${d.version === 1 ? "Recorded" : d.status === "retracted" ? "Retracted" : "Updated"}: ${d.title}`,
      metadata: d.author_name,
      room_id: d.room_id,
      room_name: d.room_name,
      created_at: d.created_at,
    })),
    ...tasks.rows.map((t) => ({
      id: t.id,
      type: "task",
      title: t.title,
      metadata: `${t.status} · ${t.assignee_name}`,
      room_id: t.room_id,
      room_name: t.room_name,
      created_at: t.updated_at,
    })),
    ...mentions.rows.map((m) => ({
      id: m.id,
      type: "mention",
      title: m.content,
      metadata: m.sender_name,
      room_id: m.room_id,
      room_name: m.room_name,
      created_at: m.created_at,
    })),
    ...files.rows.map((f) => ({
      id: f.id,
      type: "file",
      title: f.filename,
      metadata: f.sender_name,
      room_id: f.room_id,
      room_name: f.room_name,
      created_at: f.created_at,
    })),
    ...activity.rows.map((a) => ({
      id: `activity-${a.room_id}`,
      type: "activity",
      title: `${a.message_count} new messages`,
      metadata: null,
      room_id: a.room_id,
      room_name: a.room_name,
      created_at: a.last_activity_at,
    })),
  ];

  // Sort by created_at descending
  items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return ok(res, {
    items,
    summary: {
      headline: `${items.length} meaningful updates`,
      summary: `${decisions.rows.length} decisions, ${tasks.rows.length} task changes, ${mentions.rows.length} mentions, ${files.rows.length} files.`,
    },
  });
});

// ---------- markDigestRead ----------
// Advance the digest pointer.
//
// Separate from last_seen_at and advanced only from here, which is the whole
// point of migration 018. Opening a room used to advance the read receipt, and
// the digest filtered on that receipt, so arriving at the app and then opening
// /digest showed an empty page for a workspace full of activity.
//
// Takes an optional roomId to clear one room; with no body it clears every room
// the caller is in. Updating rather than inserting because the row already
// exists — room_members is how membership is stored — and the column is NOT
// NULL with a default, so a room the caller has never marked simply updates
// from its initial value.
//
// The message deliberately does not advance last_seen_at. "I have seen the
// catch-up list" and "I have read the messages" are different claims, and
// conflating them is what broke this in the first place.
const markDigestRead = asyncHandler(async (req, res) => {
  const { roomId } = req.body || {};

  if (roomId) {
    const result = await query(
      `UPDATE room_members
          SET digest_seen_at = NOW()
        WHERE room_id = $1 AND user_id = $2
        RETURNING room_id`,
      [roomId, req.user.id],
    );
    if (result.rows.length === 0) {
      throw new ApiError(403, "You are not a member of this room");
    }
    return ok(res, {
      rooms: result.rows.map((r) => r.room_id),
      digestSeenAt: new Date().toISOString(),
    });
  }

  const all = await query(
    `UPDATE room_members
        SET digest_seen_at = NOW()
      WHERE user_id = $1
      RETURNING room_id`,
    [req.user.id],
  );

  return ok(res, {
    rooms: all.rows.map((r) => r.room_id),
    digestSeenAt: new Date().toISOString(),
  });
});

module.exports = { getRoomDigest, getUserDigest, markDigestRead };
