const { pool, query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const ApiError = require("../utils/ApiError");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;

function excerpt(value, fallback = "") {
  const words = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const chars = Array.from(words);
  return chars.length > 240 ? `${chars.slice(0, 239).join("")}…` : words || fallback;
}

async function readDigestSnapshot(build) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const data = await build(client.query.bind(client));
    await client.query("COMMIT");
    return data;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function readCursor(value) {
  if (!value) return null;
  try {
    if (typeof value !== "string" || value.length > 512) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Number.isFinite(Date.parse(cursor.snapshot)) ||
        !Number.isFinite(Date.parse(cursor.created_at)) ||
        !Number.isInteger(cursor.priority) || cursor.priority < 0 || cursor.priority > 2 ||
        typeof cursor.event_id !== "string" || cursor.event_id.length > 160 ||
        !/^(decision|task:create|task|mention|file|pin):[0-9a-f-]{36}$/i.test(cursor.event_id) ||
        Date.parse(cursor.created_at) > Date.parse(cursor.snapshot)) throw new Error();
    return cursor;
  } catch { throw new ApiError(400, "Invalid digest cursor"); }
}

function digestPage(items, snapshotAt) {
  items.sort((a, b) => a.priority - b.priority ||
    (a.sort_at < b.sort_at ? 1 : a.sort_at > b.sort_at ? -1 : 0) ||
    (a.event_id < b.event_id ? 1 : a.event_id > b.event_id ? -1 : 0));
  const page = items.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: page,
    next_cursor: items.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({
      snapshot: snapshotAt, priority: last.priority,
      created_at: last.sort_at, event_id: last.event_id,
    })).toString("base64url") : null,
  };
}

function decisionItem(row) {
  const action = row.version === 1 ? "recorded" : row.status === "retracted" ? "retracted" : "edited";
  const changes = [
    row.title_changed && "Title changed",
    row.body_changed && "Details changed",
    row.tags_changed && "Tags changed",
  ].filter(Boolean);
  return {
    event_id: `decision:${row.revision_id}`, id: row.id, type: "decision", action,
    title: row.title,
    preview: excerpt(row.note || (action === "retracted" ? "Decision retracted" : changes.join(" · "))) || null,
    actor_name: row.author_name,
    metadata: row.author_name, room_id: row.room_id, room_name: row.room_name,
    created_at: row.created_at, occurred_at: row.created_at, sort_at: row.sort_at,
    priority: 1,
  };
}

function taskItem(row, userId) {
  const assigned = row.kind === "details" && row.new_assignee_id === userId &&
    row.old_assignee_id !== row.new_assignee_id;
  const action = row.kind === "create"
    ? row.assignee_id === userId && row.actor_id !== userId ? "assigned" : "created"
    : row.kind === "note" ? "note"
    : row.kind === "status" ? row.new_status === "done" ? "completed"
      : row.new_status === "open" ? "reopened" : "progress"
    : assigned ? "assigned"
    : row.old_assignee_id !== row.new_assignee_id ? "reassigned" : "edited";
  const changes = [];
  if (row.kind === "status" && row.old_status && row.new_status)
    changes.push(`${row.old_status.replaceAll("_", " ")} → ${row.new_status.replaceAll("_", " ")}`);
  if (row.kind === "details") {
    if (row.old_assignee_id !== row.new_assignee_id)
      changes.push(`Assignee: ${row.old_assignee_name || "Unassigned"} → ${row.new_assignee_name || "Unassigned"}`);
    if (row.old_title && row.new_title && row.old_title !== row.new_title)
      changes.push(`Title: ${row.old_title} → ${row.new_title}`);
    if (row.old_due_date !== row.new_due_date)
      changes.push(`Due: ${row.old_due_date || "None"} → ${row.new_due_date || "None"}`);
  }
  if (row.kind === "create") {
    changes.push(`Assigned to ${row.new_assignee_name || "nobody yet"}`);
    if (row.new_due_date) changes.push(`Due ${row.new_due_date}`);
  }
  return {
    event_id: `task:${row.update_id || `create:${row.id}`}`, id: row.id,
    type: "task", action, title: row.title,
    preview: excerpt(row.kind === "note" ? row.body : changes.join(" · ")) || null,
    actor_name: row.author_name, metadata: row.author_name,
    room_id: row.room_id, room_name: row.room_name,
    created_at: row.created_at, occurred_at: row.created_at, sort_at: row.sort_at,
    priority: assigned || action === "assigned" ? 0 : 1,
  };
}

function digestSummary(items, hasMore = false) {
  const count = (type) => items.filter((item) => item.type === type).length;
  const direct = count("mention") + items.filter((item) => item.type === "task" && item.priority === 0).length;
  const updates = count("decision") + count("task") - items.filter((item) => item.type === "task" && item.priority === 0).length;
  const shared = count("file") + count("pin");
  const parts = [
    direct && `${direct} for you`,
    updates && `${updates} decision or task update${updates === 1 ? "" : "s"}`,
    shared && `${shared} shared item${shared === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return {
    headline: items.length ? `${items.length}${hasMore ? "+" : ""} update${items.length === 1 && !hasMore ? "" : "s"} worth a look` : "You're caught up",
    summary: parts.length ? `${parts.join(" · ")}${hasMore ? " in the latest page" : ""}` : "No important updates since you last marked the digest as read.",
  };
}

// Rule-based catch-up since each room's explicit digest read pointer.

// Mentions come from the message_mentions table (BACKEND_TASKS.md item H), not
// from matching display names against message text. The name matcher is still
// used by createMessage as a temporary fallback for clients that send no
// mentionedUserIds — see services/mention.service.js.

// ---------- getRoomDigest ----------
// Per-room digest: events since the user last cleared this room's digest.
const getRoomDigest = asyncHandler(async (req, res) => {
  const data = await readDigestSnapshot(async (read) => {
  const { roomId } = req.params;
  const cursor = readCursor(req.query.cursor);
  const snapshotAt = cursor?.snapshot || (await read(`SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS snapshot_at`)).rows[0].snapshot_at;
  const beforeAt = cursor?.created_at || null;
  const beforeId = cursor?.event_id || null;
  const beforePriority = cursor?.priority ?? null;

  // 1. Verify membership and get the digest pointer.
  //
  // Opening a room advances the message read receipt, not digest_seen_at.
  const membership = await read(
    `SELECT rm.digest_seen_at, rm.cleared_at, r.name AS room_name
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

  // 2. Each decision revision since the digest was read.
  const decisions = await read(
    `SELECT d.id, dr.id AS revision_id, dr.title, dr.note,
            dr.changed_at AS created_at,
            to_char(dr.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
            dr.status, dr.version,
            (dr.title IS DISTINCT FROM prev.title) AS title_changed,
            (dr.body IS DISTINCT FROM prev.body) AS body_changed,
            (dr.tags IS DISTINCT FROM prev.tags) AS tags_changed,
            u.display_name AS author_name
     FROM decisions d
     INNER JOIN decision_revisions dr ON dr.decision_id=d.id
     LEFT JOIN decision_revisions prev ON prev.decision_id=dr.decision_id AND prev.version=dr.version-1
     INNER JOIN users u ON u.id = dr.changed_by
     WHERE d.room_id = $1 AND dr.changed_by <> $8 AND dr.changed_at > $2
       AND ($3::timestamptz IS NULL OR dr.changed_at > $3)
       AND dr.changed_at <= $4::timestamptz
       AND ($7::int IS NULL OR 1 > $7 OR (1 = $7 AND
            (dr.changed_at < $5 OR (dr.changed_at = $5 AND ('decision:' || dr.id::text) < $6))))
     ORDER BY dr.changed_at DESC, dr.id DESC LIMIT 51`,
    [roomId, lastSeenAt, membership.rows[0].cleared_at,
      snapshotAt, beforeAt, beforeId, beforePriority, req.user.id],
  );

  // 3. Creation and each task update, visible to current room members.
  const tasks = await read(
    `SELECT t.id, COALESCE(t.initial_title,t.title) AS title, t.initial_assignee_id AS assignee_id, t.created_by AS actor_id,
            NULL::uuid AS update_id, 'create' AS kind, NULL::text AS body,
            NULL::text AS old_status, NULL::text AS new_status,
            NULL::uuid AS old_assignee_id, NULL::uuid AS new_assignee_id,
            NULL::text AS old_assignee_name, created_assignee.display_name AS new_assignee_name,
            NULL::text AS old_title, NULL::text AS new_title,
            NULL::text AS old_due_date, to_char(t.initial_due_date,'YYYY-MM-DD') AS new_due_date, t.created_at,
            to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
            u.display_name AS author_name, ('task:create:' || t.id::text) AS sort_key,
            CASE WHEN t.initial_assignee_id=$8 AND t.created_by<>$8 THEN 0 ELSE 1 END AS sort_priority
     FROM tasks t JOIN users u ON u.id=t.created_by
     LEFT JOIN users created_assignee ON created_assignee.id=t.initial_assignee_id
     WHERE t.room_id=$1 AND t.created_by<>$8 AND t.created_at>$2
       AND ($3::timestamptz IS NULL OR t.created_at>$3)
       AND t.created_at <= $4::timestamptz
       AND ($7::int IS NULL OR
            (CASE WHEN t.initial_assignee_id=$8 AND t.created_by<>$8 THEN 0 ELSE 1 END)>$7 OR
            ((CASE WHEN t.initial_assignee_id=$8 AND t.created_by<>$8 THEN 0 ELSE 1 END)=$7 AND
             (t.created_at < $5 OR (t.created_at=$5 AND ('task:create:' || t.id::text)<$6))))
     UNION ALL
     SELECT t.id, COALESCE(tu.event_title,tu.new_title,t.title), t.assignee_id, tu.author_id, tu.id, tu.kind,
            tu.body, tu.old_status, tu.new_status, tu.old_assignee_id, tu.new_assignee_id,
            old_a.display_name, new_a.display_name,
            tu.old_title, tu.new_title,
            to_char(tu.old_due_date,'YYYY-MM-DD'), to_char(tu.new_due_date,'YYYY-MM-DD'),
            tu.created_at,
            to_char(tu.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            u.display_name, ('task:' || tu.id::text),
            CASE WHEN tu.kind='details' AND tu.new_assignee_id=$8
              AND tu.old_assignee_id IS DISTINCT FROM tu.new_assignee_id THEN 0 ELSE 1 END
     FROM task_updates tu JOIN tasks t ON t.id=tu.task_id
     JOIN users u ON u.id=tu.author_id
     LEFT JOIN users old_a ON old_a.id=tu.old_assignee_id
     LEFT JOIN users new_a ON new_a.id=tu.new_assignee_id
     WHERE t.room_id=$1 AND tu.author_id<>$8 AND tu.created_at>$2
       AND ($3::timestamptz IS NULL OR tu.created_at>$3)
       AND tu.created_at <= $4::timestamptz
       AND ($7::int IS NULL OR
            (CASE WHEN tu.kind='details' AND tu.new_assignee_id=$8
              AND tu.old_assignee_id IS DISTINCT FROM tu.new_assignee_id THEN 0 ELSE 1 END)>$7 OR
            ((CASE WHEN tu.kind='details' AND tu.new_assignee_id=$8
              AND tu.old_assignee_id IS DISTINCT FROM tu.new_assignee_id THEN 0 ELSE 1 END)=$7 AND
             (tu.created_at < $5 OR (tu.created_at=$5 AND ('task:' || tu.id::text)<$6))))
     ORDER BY sort_priority ASC, created_at DESC, sort_key DESC LIMIT 51`,
    [roomId, lastSeenAt, membership.rows[0].cleared_at,
      snapshotAt, beforeAt, beforeId, beforePriority, req.user.id],
  );

  // 4. Messages that @-mention me since last visit.
  //
  // Joined on message_mentions rather than matched against the message text
  // (BACKEND_TASKS.md item H). Deliberately no text fallback: a message sent by a
  // client predating structured mentions simply has no rows and does not appear,
  // whereas re-deriving mentions from text here would reintroduce the exact
  // rename bug item H removes — on historical rows, where it matters most, because
  // a name may have changed since those messages were written.
  const mentions = await read(
    `SELECT m.id,
            CASE WHEN r.encryption_mode='e2ee-v1' THEN NULL ELSE m.content END AS content,
            m.created_at,
            to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
            u.display_name AS sender_name
     FROM message_mentions mm
     INNER JOIN messages m ON m.id = mm.message_id
     INNER JOIN rooms r ON r.id=m.room_id
     INNER JOIN users u ON u.id = m.sender_id
     WHERE m.room_id = $1 AND message_visible(m.id,$3)
       AND m.created_at > $2
       AND mm.user_id = $3
       AND m.sender_id != $3
       AND m.deleted_at IS NULL
       AND m.created_at <= $4::timestamptz
       AND ($7::int IS NULL OR 0 > $7 OR (0 = $7 AND
            (m.created_at < $5 OR (m.created_at = $5 AND ('mention:' || m.id::text) < $6))))
     ORDER BY m.created_at DESC, m.id DESC LIMIT 51`,
    [roomId, lastSeenAt, req.user.id, snapshotAt, beforeAt, beforeId, beforePriority],
  );

  // 5. New attachments since last visit
  const files = await read(
    `SELECT a.id,
            CASE WHEN r.encryption_mode='e2ee-v1' THEN 'Encrypted file' ELSE COALESCE(a.filename,'Shared file') END AS filename,
            a.file_type, a.size_bytes, a.created_at,
            to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
            m.id AS message_id,
            u.display_name AS sender_name
     FROM attachments a
     INNER JOIN messages m ON m.id = a.message_id
     INNER JOIN rooms r ON r.id = m.room_id
     INNER JOIN users u ON u.id = m.sender_id
     WHERE m.room_id = $1 AND message_visible(m.id,$3) AND a.created_at > $2
       AND m.deleted_at IS NULL AND m.sender_id <> $3
       AND NOT EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.user_id=$3)
       AND a.created_at <= $4::timestamptz
       AND ($7::int IS NULL OR 2 > $7 OR (2 = $7 AND
            (a.created_at < $5 OR (a.created_at = $5 AND ('file:' || a.id::text) < $6))))
     ORDER BY a.created_at DESC, a.id DESC LIMIT 51`,
    [roomId, lastSeenAt, req.user.id, snapshotAt, beforeAt, beforeId, beforePriority],
  );

  // A room pin is a deliberate signal that a message matters to the room.
  const pins = await read(
    `SELECT m.id, p.pinned_at AS created_at,
            to_char(p.pinned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
            CASE WHEN r.encryption_mode='e2ee-v1' THEN NULL ELSE m.content END AS content,
            u.display_name AS actor_name
     FROM message_pins p JOIN messages m ON m.id=p.message_id
     JOIN rooms r ON r.id=m.room_id JOIN users u ON u.id=p.user_id
     WHERE m.room_id=$1 AND p.scope='room' AND p.pinned_at>$2
       AND ($4::timestamptz IS NULL OR p.pinned_at>$4)
       AND m.deleted_at IS NULL AND message_visible(m.id,$3)
       AND p.user_id <> $3 AND p.pinned_at <= $5::timestamptz
       AND ($8::int IS NULL OR 1 > $8 OR (1 = $8 AND
            (p.pinned_at < $6 OR (p.pinned_at = $6 AND ('pin:' || p.message_id::text) < $7))))
     ORDER BY p.pinned_at DESC, p.message_id DESC LIMIT 51`,
    [roomId, lastSeenAt, req.user.id, membership.rows[0].cleared_at,
      snapshotAt, beforeAt, beforeId, beforePriority],
  );

  const items = [
    ...decisions.rows.map((d) => decisionItem({ ...d, room_id: roomId, room_name: roomName })),
    ...tasks.rows.map((t) => taskItem({ ...t, room_id: roomId, room_name: roomName }, req.user.id)),
    ...mentions.rows.map((m) => ({
      event_id: `mention:${m.id}`,
      id: m.id,
      type: "mention",
      action: "mentioned",
      title: excerpt(m.content, "Mentioned you"),
      metadata: m.sender_name,
      actor_name: m.sender_name,
      priority: 0,
      message_id: m.id,
      room_id: roomId,
      room_name: roomName,
      created_at: m.created_at,
      sort_at: m.sort_at,
    })),
    ...files.rows.map((f) => ({
      event_id: `file:${f.id}`,
      id: f.id,
      type: "file",
      action: "shared",
      title: f.filename,
      metadata: f.sender_name,
      actor_name: f.sender_name,
      priority: 2,
      message_id: f.message_id,
      room_id: roomId,
      room_name: roomName,
      created_at: f.created_at,
      sort_at: f.sort_at,
    })),
    ...pins.rows.map((p) => ({
      event_id: `pin:${p.id}`, id: p.id, type: "pin", action: "pinned",
      title: excerpt(p.content, "Pinned message"), actor_name: p.actor_name, priority: 1,
      message_id: p.id, room_id: roomId, room_name: roomName, created_at: p.created_at,
      sort_at: p.sort_at,
    })),
  ];

  const page = digestPage(items, snapshotAt);

  return {
    ...page,
    rooms: [{ room_id: roomId, room_name: roomName }],
    snapshot_at: snapshotAt,
    summary: digestSummary(page.items, Boolean(page.next_cursor)),
  };
  });
  return ok(res, data);
});

// ---------- getUserDigest ----------
// Cross-room: aggregate digest across all rooms the user is in
const getUserDigest = asyncHandler(async (req, res) => {
  const data = await readDigestSnapshot(async (read) => {
  const cursor = readCursor(req.query.cursor);
  const snapshotAt = cursor?.snapshot || (await read(`SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS snapshot_at`)).rows[0].snapshot_at;
  const beforeAt = cursor?.created_at || null;
  const beforeId = cursor?.event_id || null;
  const beforePriority = cursor?.priority ?? null;
  const rooms = await read(
    `SELECT rm.room_id, r.name AS room_name FROM room_members rm
     JOIN rooms r ON r.id=rm.room_id WHERE rm.user_id = $1`,
    [req.user.id],
  );

  const roomIds = rooms.rows.map((r) => r.room_id);
  if (roomIds.length === 0) {
    return {
      items: [],
      next_cursor: null,
      rooms: [],
      snapshot_at: snapshotAt,
      summary: { headline: "No updates", summary: "You are not in any rooms." },
    };
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
  const decisions = await read(
    `SELECT d.id, dr.id AS revision_id, dr.title, dr.note,
            dr.changed_at AS created_at,
            to_char(dr.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
            dr.status, dr.version, d.room_id,
            (dr.title IS DISTINCT FROM prev.title) AS title_changed,
            (dr.body IS DISTINCT FROM prev.body) AS body_changed,
            (dr.tags IS DISTINCT FROM prev.tags) AS tags_changed,
            r.name AS room_name, u.display_name AS author_name
     FROM decisions d
     INNER JOIN rooms r ON r.id = d.room_id
     INNER JOIN room_members rm ON rm.room_id = d.room_id AND rm.user_id = $2
     INNER JOIN decision_revisions dr ON dr.decision_id=d.id
     LEFT JOIN decision_revisions prev ON prev.decision_id=dr.decision_id AND prev.version=dr.version-1
     INNER JOIN users u ON u.id = dr.changed_by
     WHERE d.room_id = ANY($1) AND dr.changed_by <> $2 AND dr.changed_at > rm.digest_seen_at
       AND (rm.cleared_at IS NULL OR dr.changed_at > rm.cleared_at)
       AND dr.changed_at <= $3::timestamptz
       AND ($6::int IS NULL OR 1 > $6 OR (1 = $6 AND
            (dr.changed_at < $4 OR (dr.changed_at = $4 AND ('decision:' || dr.id::text) < $5))))
     ORDER BY dr.changed_at DESC, dr.id DESC LIMIT 51`,
    [roomIds, req.user.id, snapshotAt, beforeAt, beforeId, beforePriority],
  );

  // 2. Creation and each task update across current rooms.
  const tasks = await read(
    `SELECT t.id, COALESCE(t.initial_title,t.title) AS title, t.initial_assignee_id AS assignee_id, t.created_by AS actor_id,
            NULL::uuid AS update_id, 'create' AS kind, NULL::text AS body,
            NULL::text AS old_status, NULL::text AS new_status,
            NULL::uuid AS old_assignee_id, NULL::uuid AS new_assignee_id,
            NULL::text AS old_assignee_name, created_assignee.display_name AS new_assignee_name,
            NULL::text AS old_title, NULL::text AS new_title,
            NULL::text AS old_due_date, to_char(t.initial_due_date,'YYYY-MM-DD') AS new_due_date, t.created_at,
            to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
            t.room_id, r.name AS room_name, u.display_name AS author_name,
            ('task:create:' || t.id::text) AS sort_key,
            CASE WHEN t.initial_assignee_id=$2 AND t.created_by<>$2 THEN 0 ELSE 1 END AS sort_priority
     FROM tasks t
     INNER JOIN rooms r ON r.id = t.room_id
     INNER JOIN users u ON u.id = t.created_by
     LEFT JOIN users created_assignee ON created_assignee.id=t.initial_assignee_id
     INNER JOIN room_members rm ON rm.room_id = t.room_id AND rm.user_id = $2
     WHERE t.room_id = ANY($1) AND t.created_by <> $2 AND t.created_at > rm.digest_seen_at
       AND (rm.cleared_at IS NULL OR t.created_at > rm.cleared_at)
       AND t.created_at <= $3::timestamptz
       AND ($6::int IS NULL OR
            (CASE WHEN t.initial_assignee_id=$2 AND t.created_by<>$2 THEN 0 ELSE 1 END)>$6 OR
            ((CASE WHEN t.initial_assignee_id=$2 AND t.created_by<>$2 THEN 0 ELSE 1 END)=$6 AND
             (t.created_at<$4 OR (t.created_at=$4 AND ('task:create:' || t.id::text)<$5))))
     UNION ALL
     SELECT t.id, COALESCE(tu.event_title,tu.new_title,t.title), t.assignee_id, tu.author_id, tu.id, tu.kind,
            tu.body, tu.old_status, tu.new_status, tu.old_assignee_id, tu.new_assignee_id,
            old_a.display_name, new_a.display_name,
            tu.old_title, tu.new_title,
            to_char(tu.old_due_date,'YYYY-MM-DD'), to_char(tu.new_due_date,'YYYY-MM-DD'),
            tu.created_at,
            to_char(tu.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            t.room_id, r.name, u.display_name,
            ('task:' || tu.id::text),
            CASE WHEN tu.kind='details' AND tu.new_assignee_id=$2
              AND tu.old_assignee_id IS DISTINCT FROM tu.new_assignee_id THEN 0 ELSE 1 END
     FROM task_updates tu JOIN tasks t ON t.id=tu.task_id
     JOIN rooms r ON r.id=t.room_id
     JOIN users u ON u.id=tu.author_id
     LEFT JOIN users old_a ON old_a.id=tu.old_assignee_id
     LEFT JOIN users new_a ON new_a.id=tu.new_assignee_id
     JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=$2
     WHERE t.room_id=ANY($1) AND tu.author_id<>$2 AND tu.created_at>rm.digest_seen_at
       AND (rm.cleared_at IS NULL OR tu.created_at>rm.cleared_at)
       AND tu.created_at <= $3::timestamptz
       AND ($6::int IS NULL OR
            (CASE WHEN tu.kind='details' AND tu.new_assignee_id=$2
              AND tu.old_assignee_id IS DISTINCT FROM tu.new_assignee_id THEN 0 ELSE 1 END)>$6 OR
            ((CASE WHEN tu.kind='details' AND tu.new_assignee_id=$2
              AND tu.old_assignee_id IS DISTINCT FROM tu.new_assignee_id THEN 0 ELSE 1 END)=$6 AND
             (tu.created_at<$4 OR (tu.created_at=$4 AND ('task:' || tu.id::text)<$5))))
     ORDER BY sort_priority ASC, created_at DESC, sort_key DESC LIMIT 51`,
    [roomIds, req.user.id, snapshotAt, beforeAt, beforeId, beforePriority],
  );

  // 3. Messages that @-mention me.
  //
  // Same message_mentions join as the per-room digest, and the same deliberate
  // absence of a text fallback.
  const mentions = await read(
    `SELECT m.id,
            CASE WHEN r.encryption_mode='e2ee-v1' THEN NULL ELSE m.content END AS content,
            m.created_at,
            to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
            m.room_id,
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
       AND m.created_at <= $3::timestamptz
       AND ($6::int IS NULL OR 0 > $6 OR (0 = $6 AND
            (m.created_at < $4 OR (m.created_at = $4 AND ('mention:' || m.id::text) < $5))))
     ORDER BY m.created_at DESC, m.id DESC LIMIT 51`,
    [roomIds, req.user.id, snapshotAt, beforeAt, beforeId, beforePriority],
  );

  // 4. New attachments
  const files = await read(
    `SELECT a.id,
            CASE WHEN r.encryption_mode='e2ee-v1' THEN 'Encrypted file' ELSE COALESCE(a.filename,'Shared file') END AS filename,
            a.file_type, a.size_bytes, a.created_at,
            to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
            m.id AS message_id, m.room_id, r.name AS room_name, u.display_name AS sender_name
     FROM attachments a
     INNER JOIN messages m ON m.id = a.message_id
     INNER JOIN rooms r ON r.id = m.room_id
     INNER JOIN users u ON u.id = m.sender_id
     INNER JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
     WHERE m.room_id = ANY($1) AND message_visible(m.id,$2)
       AND a.created_at > rm.digest_seen_at
       AND m.deleted_at IS NULL AND m.sender_id <> $2
       AND NOT EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.user_id=$2)
       AND a.created_at <= $3::timestamptz
       AND ($6::int IS NULL OR 2 > $6 OR (2 = $6 AND
            (a.created_at < $4 OR (a.created_at = $4 AND ('file:' || a.id::text) < $5))))
     ORDER BY a.created_at DESC, a.id DESC LIMIT 51`,
    [roomIds, req.user.id, snapshotAt, beforeAt, beforeId, beforePriority],
  );

  // Room-wide pins are intentional highlights; ordinary message traffic is
  // already visible in the chat list and does not make the catch-up digest.
  const pins = await read(
    `SELECT m.id, m.room_id, r.name AS room_name, p.pinned_at AS created_at,
            to_char(p.pinned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
            CASE WHEN r.encryption_mode='e2ee-v1' THEN NULL ELSE m.content END AS content,
            u.display_name AS actor_name
     FROM message_pins p JOIN messages m ON m.id=p.message_id
     JOIN rooms r ON r.id=m.room_id JOIN users u ON u.id=p.user_id
     JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=$2
     WHERE m.room_id=ANY($1) AND p.scope='room' AND p.pinned_at>rm.digest_seen_at
       AND (rm.cleared_at IS NULL OR p.pinned_at>rm.cleared_at)
       AND m.deleted_at IS NULL AND message_visible(m.id,$2)
       AND p.user_id <> $2 AND p.pinned_at <= $3::timestamptz
       AND ($6::int IS NULL OR 1 > $6 OR (1 = $6 AND
            (p.pinned_at < $4 OR (p.pinned_at = $4 AND ('pin:' || p.message_id::text) < $5))))
     ORDER BY p.pinned_at DESC, p.message_id DESC LIMIT 51`,
    [roomIds, req.user.id, snapshotAt, beforeAt, beforeId, beforePriority],
  );

  const items = [
    ...decisions.rows.map(decisionItem),
    ...tasks.rows.map((t) => taskItem(t, req.user.id)),
    ...mentions.rows.map((m) => ({
      event_id: `mention:${m.id}`,
      id: m.id,
      type: "mention",
      action: "mentioned",
      title: excerpt(m.content, "Mentioned you"),
      metadata: m.sender_name,
      actor_name: m.sender_name,
      priority: 0,
      message_id: m.id,
      room_id: m.room_id,
      room_name: m.room_name,
      created_at: m.created_at,
      sort_at: m.sort_at,
    })),
    ...files.rows.map((f) => ({
      event_id: `file:${f.id}`,
      id: f.id,
      type: "file",
      action: "shared",
      title: f.filename,
      metadata: f.sender_name,
      actor_name: f.sender_name,
      priority: 2,
      message_id: f.message_id,
      room_id: f.room_id,
      room_name: f.room_name,
      created_at: f.created_at,
      sort_at: f.sort_at,
    })),
    ...pins.rows.map((p) => ({
      event_id: `pin:${p.id}`, id: p.id, type: "pin", action: "pinned",
      title: excerpt(p.content, "Pinned message"), actor_name: p.actor_name, priority: 1,
      message_id: p.id, room_id: p.room_id, room_name: p.room_name, created_at: p.created_at,
      sort_at: p.sort_at,
    })),
  ];

  const page = digestPage(items, snapshotAt);

  return {
    ...page,
    rooms: rooms.rows,
    snapshot_at: snapshotAt,
    summary: digestSummary(page.items, Boolean(page.next_cursor)),
  };
  });
  return ok(res, data);
});

// ---------- markDigestRead ----------
// Advance the digest pointer.
//
// Separate from last_seen_at and advanced only from here, which is the whole
// point of migration 018. Opening a room used to advance the read receipt, and
// the digest filtered on that receipt, so arriving at the app and then opening
// /digest showed an empty page for a workspace full of activity.
//
// Takes one room, a list of room IDs, or all current rooms. Updating rather
// than inserting because the row already
// exists — room_members is how membership is stored — and the column is NOT
// NULL with a default, so a room the caller has never marked simply updates
// from its initial value.
//
// The message deliberately does not advance last_seen_at. "I have seen the
// catch-up list" and "I have read the messages" are different claims, and
// conflating them is what broke this in the first place.
const markDigestRead = asyncHandler(async (req, res) => {
  const { roomId, roomIds, observedAt } = req.body || {};
  if (roomId != null && !UUID_RE.test(roomId)) throw new ApiError(400, "Invalid room");
  if (roomIds != null && (!Array.isArray(roomIds) || roomIds.length > 500 ||
      roomIds.some((id) => !UUID_RE.test(id)))) throw new ApiError(400, "Invalid rooms");
  if (roomId && roomIds) throw new ApiError(400, "Choose one room or a list of rooms");
  if (observedAt != null && (typeof observedAt !== "string" ||
      !Number.isFinite(Date.parse(observedAt))))
    throw new ApiError(400, "Invalid digest time");
  const target = observedAt || new Date().toISOString();

  if (roomId) {
    const result = await query(
      `UPDATE room_members
          SET digest_seen_at = GREATEST(digest_seen_at, LEAST($3::timestamptz, NOW()))
        WHERE room_id = $1 AND user_id = $2
        RETURNING room_id, digest_seen_at`,
      [roomId, req.user.id, target],
    );
    if (result.rows.length === 0) {
      throw new ApiError(403, "You are not a member of this room");
    }
    return ok(res, {
      rooms: result.rows.map((r) => r.room_id),
      digestSeenAt: result.rows[0].digest_seen_at,
    });
  }

  const all = await query(
    `UPDATE room_members
        SET digest_seen_at = GREATEST(digest_seen_at, LEAST($2::timestamptz, NOW()))
      WHERE user_id = $1 AND ($3::uuid[] IS NULL OR room_id = ANY($3::uuid[]))
      RETURNING room_id, digest_seen_at`,
    [req.user.id, target, roomIds || null],
  );

  return ok(res, {
    rooms: all.rows.map((r) => r.room_id),
    digestSeenAt: target,
  });
});

module.exports = { getRoomDigest, getUserDigest, markDigestRead };
