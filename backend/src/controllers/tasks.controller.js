const { query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const ApiError = require("../utils/ApiError");
const {
  createNotification,
  presentNotification,
  emitNotification,
  personalRoom,
} = require("../services/notification.service");

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

const STATUSES = ["open", "in_progress", "done"];

// The notes a flag-as-task dialog collects. The column is unbounded so the
// limit lives in one place with the other input validation rather than being
// duplicated as a column constraint that could drift from it.
const MAX_BODY_LENGTH = 2000;

// One shape for every task this module returns, matching what Tasks.jsx reads
// (status, due_date, title, assignee_name, id) and the devPreview fixtures. Kept
// as constants so create, list and update cannot drift apart — the same
// shape-drift bug the attachment payloads had (BACKEND_TASKS.md Bug 6).
//
// a is LEFT JOINed: a task may be unassigned, and an INNER JOIN would silently
// drop those rows from the board rather than showing them with a blank assignee.
const TASK_COLUMNS = `
  t.id, t.room_id, t.source_message_id, t.title, t.body,
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

// Only the people who can see a task are told it changed. The old emit went to
// the whole room, which leaked every private task to every member.
async function emitTaskUpdated(io, task) {
  if (!io) return;
  const admins = await query(
    `SELECT user_id FROM room_members WHERE room_id = $1 AND role = 'admin'`,
    [task.room_id],
  );
  const audience = new Set(
    [
      task.assignee_id,
      task.created_by,
      ...admins.rows.map((row) => row.user_id),
    ].filter(Boolean),
  );
  audience.forEach((id) =>
    io.to(personalRoom(id)).emit("task:updated", { task }),
  );
}

// ---------- createTask ----------
// Flag a message as a task, optionally assigning it to a room member.
const createTask = asyncHandler(async (req, res) => {
  const { roomId, sourceMessageId, title, body, assigneeId, dueDate } =
    req.body;

  if (!roomId || typeof title !== "string" || !title.trim()) {
    throw new ApiError(400, "roomId and title are required");
  }

  const membership = await query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, req.user.id],
  );
  if (membership.rows.length === 0) {
    throw new ApiError(403, "You are not a member of this room");
  }

  if (
    (
      await query(
        "SELECT 1 FROM rooms WHERE id=$1 AND encryption_mode='e2ee-v1'",
        [roomId],
      )
    ).rowCount
  )
    throw new ApiError(
      409,
      "Server-readable collaboration is unavailable in encrypted conversations",
    );

  // A source message has to be in the same room, or the task links across rooms
  // and the message view would render a task it has no permission context for.
  if (sourceMessageId) {
    const source = await query(
      `SELECT 1 FROM messages WHERE id = $1 AND room_id = $2 AND deleted_at IS NULL`,
      [sourceMessageId, roomId],
    );
    if (source.rows.length === 0) {
      throw new ApiError(400, "sourceMessageId is not a message in this room");
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
      throw new ApiError(400, "assigneeId must be a member of this room");
    }
  }

  if (
    body !== undefined &&
    body !== null &&
    String(body).length > MAX_BODY_LENGTH
  ) {
    throw new ApiError(
      400,
      `body must be at most ${MAX_BODY_LENGTH} characters`,
    );
  }

  // The CTE inserts, then selects through the shared column list, so the 201
  // response carries the same shape listTasks returns. A bare RETURNING * would
  // hand back the raw columns with no room_name or assignee_name.
  const result = await query(
    `WITH inserted AS (
       INSERT INTO tasks
         (room_id, source_message_id, title, body, assignee_id, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *
     )
     SELECT ${TASK_COLUMNS}
     FROM inserted t
     INNER JOIN rooms r ON r.id = t.room_id
     LEFT JOIN users a ON a.id = t.assignee_id`,
    [
      roomId,
      sourceMessageId || null,
      title.trim(),
      body ? String(body).trim() : null,
      assigneeId || null,
      dueDate || null,
      req.user.id,
    ],
  );

  const task = result.rows[0];

  // Announced only to the people who can see it: the assignee, the creator and
  // the room's admins. Emitting to the room would have told every member that a
  // private task exists, which the list query above deliberately hides from
  // them. The caller still gets the task in the response, so the client that
  // made the change is never left showing stale state.
  const io = req.app.get("io");
  await emitTaskUpdated(io, task);

  /*
   * Tell the assignee.
   *
   * Two cases deliberately notify nobody, and both are guarded here rather than
   * left to createNotification:
   *
   *   - No assignee. An unassigned task is nobody's to act on, and the digest
   *     already filters on assignee_id, so it surfaces to nobody either.
   *   - Self-assigned. createNotification throws 400 when actorId equals
   *     recipientId, so letting it through would turn a perfectly ordinary
   *     "make me a task" into a failed request. Skipped at the call site, the
   *     same way message.service excludes the sender from a self-mention.
   *
   * Written after the task commits rather than inside the INSERT, because the
   * notification references the task id.
   */
  let notificationRow = null;
  if (task.assignee_id && task.assignee_id !== req.user.id) {
    try {
      notificationRow = await createNotification({
        recipientId: task.assignee_id,
        type: "task",
        referenceId: task.id,
        actorId: req.user.id,
      });
    } catch (err) {
      // The task itself is created and correct. A failed notification must not
      // undo that or fail the request — the assignee sees it on the board.
      console.error("Could not write task notification", {
        taskId: task.id,
        assignee: task.assignee_id,
        message: err.message,
      });
    }
  }

  // Resolved and pushed only after the row exists, same as addMember's invite.
  if (notificationRow) {
    const presented = await presentNotification(notificationRow);
    emitNotification(io, task.assignee_id, presented);
  }

  return ok(res, task, 201);
});

// ---------- listTasks ----------
// Cross-room by default, because the Tasks page is top-level. Optional
// ?roomId for the per-room tab, ?status and ?assigneeId to narrow further.
const listTasks = asyncHandler(async (req, res) => {
  const { roomId, status, assigneeId } = req.query;

  if (status && !STATUSES.includes(status)) {
    throw new ApiError(400, `status must be one of: ${STATUSES.join(", ")}`);
  }

  // Visibility, not membership, is the scope. Three people may see a task: the
  // assignee (it is theirs to do), the creator (otherwise an unassigned task
  // would be invisible to the person who made it) and a room admin (otherwise
  // nobody could moderate the board). Everyone else in the room is filtered out
  // by the predicate rather than by a separate query, so the list and the
  // single-task write path below can agree on one rule.
  //
  // $1 is pre-seeded because both branches reference it: the room-scoped branch
  // repeats membership under a second parameter purely to return a 403 rather
  // than an empty list.
  const params = [req.user.id];
  const filters = [
    `(t.assignee_id = $1
      OR t.created_by = $1
      OR EXISTS (
        SELECT 1 FROM room_members adm
        WHERE adm.room_id = t.room_id AND adm.user_id = $1 AND adm.role = 'admin'
      ))`,
  ];

  if (roomId) {
    const membership = await query(
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [roomId, req.user.id],
    );
    if (membership.rows.length === 0) {
      throw new ApiError(403, "You are not a member of this room");
    }
    params.push(roomId);
    filters.push(`t.room_id = $${params.length}`);
  } else {
    // A task in a room you are not in is not merely filtered from the list, it
    // should never have been selectable.
    filters.push(
      `t.room_id IN (SELECT room_id FROM room_members WHERE user_id = $1)`,
    );
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
     WHERE ${filters.join(" AND ")}
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
    throw new ApiError(400, `status must be one of: ${STATUSES.join(", ")}`);
  }

  // The same three-way visibility rule as the list, read in the query that loads
  // the task so there is no window between authorising and acting. A plain
  // membership join let any member of the room move a task they were never
  // meant to see.
  const existing = await query(
    `SELECT t.id, t.room_id
       FROM tasks t
       INNER JOIN room_members rm ON rm.room_id = t.room_id AND rm.user_id = $2
      WHERE t.id = $1
        AND (t.assignee_id = $2 OR t.created_by = $2 OR rm.role = 'admin')`,
    [taskId, req.user.id],
  );
  if (existing.rows.length === 0) {
    throw new ApiError(404, "Task not found");
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

  await emitTaskUpdated(req.app.get("io"), task);

  return ok(res, task);
});

module.exports = { createTask, listTasks, updateTaskStatus, STATUSES };
