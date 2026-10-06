const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const ApiError = require('../utils/ApiError');

// In-chat Action Items — flag any message as a task, assign it, track
// status in a per-room Tasks tab.
//
// The table, the routes and the digest's task queries all shipped in migration
// 002; only these handlers were missing, so the digest's task section has been
// structurally correct but permanently empty.
//
// Status values are constrained by tasks_status_check (migration 011) as well as
// validated here. The controller check exists to return a useful 400; the
// constraint is what makes the guarantee real for any future write path.

const STATUSES = ['open', 'in_progress', 'done'];

// One shape for every task this module returns, matching what Tasks.jsx reads
// (status, due_date, title, assignee_name, id) and the devPreview fixtures. Kept
// as constants so create, list and update cannot drift apart — the same
// shape-drift bug the attachment payloads had (BACKEND_TASKS.md Bug 6).
//
// a is LEFT JOINed: a task may be unassigned, and an INNER JOIN would silently
// drop those rows from the board rather than showing them with a blank assignee.
const TASK_COLUMNS = `
  t.id, t.room_id, t.source_message_id, t.title,
  t.assignee_id, t.status, to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
  t.created_by, t.created_at, t.updated_at,
  r.name AS room_name,
  r.slug AS room_slug,
  a.display_name AS assignee_name`;

// The joins a real `tasks` row needs. The write paths select from a CTE of the
// same columns instead, so they cannot use these — only listTasks can.
const TASK_JOINS = `
  FROM tasks t
  INNER JOIN rooms r ON r.id = t.room_id
  LEFT JOIN users a ON a.id = t.assignee_id`;

// ---------- createTask ----------
// Flag a message as a task, optionally assigning it to a room member.
const createTask = asyncHandler(async (req, res) => {
  const { roomId, sourceMessageId, title, assigneeId, dueDate } = req.body;

  if (!roomId || typeof title !== 'string' || !title.trim()) {
    throw new ApiError(400, 'roomId and title are required');
  }

  const membership = await query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, req.user.id],
  );
  if (membership.rows.length === 0) {
    throw new ApiError(403, 'You are not a member of this room');
  }

  // A source message has to be in the same room, or the task links across rooms
  // and the message view would render a task it has no permission context for.
  if (sourceMessageId) {
    const source = await query(
      `SELECT 1 FROM messages WHERE id = $1 AND room_id = $2 AND deleted_at IS NULL`,
      [sourceMessageId, roomId],
    );
    if (source.rows.length === 0) {
      throw new ApiError(400, 'sourceMessageId is not a message in this room');
    }
  }

  // The assignee must be in the room. Without this a task can be handed to
  // someone who cannot open the room, and their digest — which filters on
  // assignee_id within a room — will never surface it.
  if (assigneeId) {
    const assignee = await query(
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [roomId, assigneeId],
    );
    if (assignee.rows.length === 0) {
      throw new ApiError(400, 'assigneeId must be a member of this room');
    }
  }

  // The CTE inserts, then selects through the shared column list, so the 201
  // response carries the same shape listTasks returns. A bare RETURNING * would
  // hand back the raw columns with no room_name or assignee_name.
  const result = await query(
    `WITH inserted AS (
       INSERT INTO tasks
         (room_id, source_message_id, title, assignee_id, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *
     )
     SELECT ${TASK_COLUMNS}
     FROM inserted t
     INNER JOIN rooms r ON r.id = t.room_id
     LEFT JOIN users a ON a.id = t.assignee_id`,
    [roomId, sourceMessageId || null, title.trim(), assigneeId || null, dueDate || null, req.user.id],
  );

  const task = result.rows[0];

  // Announced so the room's Tasks tab updates live for everyone in it.
  //
  // Known limitation: this reaches only sockets that have joined this room, and
  // joining is on-demand (client/src/hooks/useMessages.js emits join-room when a
  // room view mounts). A user sitting on the top-level cross-room Tasks page has
  // not joined the rooms it lists, so their board will not update live — only on
  // reload. Fixing that needs a per-user task subscription rather than a change
  // to this emit, so it is documented rather than built. The caller still gets
  // the updated task in the response below, so the client that made the change
  // is never left showing stale state.
  const io = req.app.get('io');
  if (io) {
    io.to(task.room_id).emit('task:updated', { task });
  }

  return ok(res, task, 201);
});

// ---------- listTasks ----------
// Cross-room by default, because the Tasks page is top-level. Optional
// ?roomId for the per-room tab, ?status and ?assigneeId to narrow further.
const listTasks = asyncHandler(async (req, res) => {
  const { roomId, status, assigneeId } = req.query;

  if (status && !STATUSES.includes(status)) {
    throw new ApiError(400, `status must be one of: ${STATUSES.join(', ')}`);
  }

  // Params are numbered as they are added rather than pre-seeded with the user
  // id. The room-scoped branch below authorises membership in its own query and
  // never needs the user id again, so a pre-seeded $1 would go unreferenced —
  // which Postgres rejects with "could not determine data type of parameter $1".
  const params = [];
  const filters = [];

  if (roomId) {
    const membership = await query(
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [roomId, req.user.id],
    );
    if (membership.rows.length === 0) {
      throw new ApiError(403, 'You are not a member of this room');
    }
    params.push(roomId);
    filters.push(`t.room_id = $${params.length}`);
  } else {
    // Membership is the scope: a task in a room you are not in is not merely
    // filtered from the list, it should never have been selectable.
    params.push(req.user.id);
    filters.push(`t.room_id IN (SELECT room_id FROM room_members WHERE user_id = $${params.length})`);
  }

  if (status) {
    params.push(status);
    filters.push(`t.status = $${params.length}`);
  }

  if (assigneeId) {
    params.push(assigneeId);
    filters.push(`t.assignee_id = $${params.length}`);
  }

  // due_date ascending with NULLs last puts undated tasks after dated ones
  // instead of treating them as infinitely overdue, which NULLS FIRST would do.
  // created_at breaks ties so the order is stable across pages.
  const result = await query(
    `SELECT ${TASK_COLUMNS}
     ${TASK_JOINS}
     WHERE ${filters.join(' AND ')}
     ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC, t.id DESC`,
    params,
  );

  return ok(res, { tasks: result.rows });
});

// ---------- updateTaskStatus ----------
// open -> in_progress -> done, emitting so the board updates live.
const updateTaskStatus = asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const { status } = req.body;

  if (!STATUSES.includes(status)) {
    throw new ApiError(400, `status must be one of: ${STATUSES.join(', ')}`);
  }

  // Membership is checked against the task's own room, read in the same query
  // that loads it, so there is no window between authorising and acting.
  const existing = await query(
    `SELECT t.id, t.room_id
     FROM tasks t
     INNER JOIN room_members rm ON rm.room_id = t.room_id AND rm.user_id = $2
     WHERE t.id = $1`,
    [taskId, req.user.id],
  );
  if (existing.rows.length === 0) {
    throw new ApiError(404, 'Task not found or you are not a member of its room');
  }

  // updated_at is set explicitly because nothing else maintains it, and the
  // digest's entire time window is `updated_at > last_seen_at`. Leaving it at
  // creation time would mean a task changed days ago never appears in anyone's
  // catch-up feed.
  const result = await query(
    `WITH updated AS (
       UPDATE tasks SET status = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING *
     )
     SELECT ${TASK_COLUMNS}
     FROM updated t
     INNER JOIN rooms r ON r.id = t.room_id
     LEFT JOIN users a ON a.id = t.assignee_id`,
    [taskId, status],
  );

  const task = result.rows[0];

  const io = req.app.get('io');
  if (io) {
    io.to(task.room_id).emit('task:updated', { task });
  }

  return ok(res, task);
});

module.exports = { createTask, listTasks, updateTaskStatus, STATUSES };