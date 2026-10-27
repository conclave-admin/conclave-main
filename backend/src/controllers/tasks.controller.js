const { pool, query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const ApiError = require("../utils/ApiError");
const {
  createNotification, presentNotification, emitNotification, personalRoom,
} = require("../services/notification.service");

const STATUSES = ["open", "in_progress", "done"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;
const COLUMNS = `t.id,t.room_id,t.source_message_id,t.decision_id,t.title,t.body,t.assignee_id,
 t.status,to_char(t.due_date,'YYYY-MM-DD') AS due_date,t.created_by,t.created_at,t.updated_at,
 r.name AS room_name,r.slug AS room_slug,d.title AS decision_title,d.status AS decision_status,a.display_name AS assignee_name,
 c.display_name AS creator_name,rm.role AS viewer_role,
 (t.assignee_id=$1::uuid) AS can_progress,
 (t.created_by=$1::uuid OR rm.role='admin') AS can_manage`;
const JOINS = `FROM tasks t JOIN rooms r ON r.id=t.room_id
 JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=$1
 LEFT JOIN decisions d ON d.id=t.decision_id
 LEFT JOIN users a ON a.id=t.assignee_id JOIN users c ON c.id=t.created_by`;

function validateTitle(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160)
    throw new ApiError(400, "Title must be 1–160 characters");
  return value.trim();
}
function validateBody(value) {
  if (value !== null && value !== undefined && (typeof value !== "string" || value.length > 2000))
    throw new ApiError(400, "Notes must be at most 2,000 characters");
  return value?.trim() || null;
}
function validateDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new ApiError(400, "Due date must be a valid calendar date");
  return value;
}
async function payload(taskId, userId, client = { query }) {
  const result = await client.query(
    `SELECT ${COLUMNS} ${JOINS} WHERE t.id=$2`, [userId, taskId],
  );
  return result.rows[0] || null;
}
async function publish(io, task) {
  if (!io || !task) return;
  const members = await query("SELECT user_id FROM room_members WHERE room_id=$1", [task.room_id]);
  for (const member of members.rows)
    io.to(personalRoom(member.user_id)).emit("task:updated", { taskId: task.id, roomId: task.room_id });
}
async function notifyAssignee(io, task, actorId) {
  if (!task.assignee_id || task.assignee_id === actorId) return;
  try {
    const row = await createNotification({ recipientId: task.assignee_id,
      type: "task", referenceId: task.id, actorId });
    emitNotification(io, task.assignee_id, await presentNotification(row));
  } catch (error) {
    console.error("Could not notify task assignee", { taskId: task.id, message: error.message });
  }
}
async function checkAssignee(client, roomId, assigneeId) {
  if (assigneeId === null) return;
  if (!UUID_RE.test(assigneeId)) throw new ApiError(400, "Invalid assignee");
  const member = await client.query(
    "SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE", [roomId, assigneeId],
  );
  if (!member.rowCount) throw new ApiError(400, "Assignee must be a current room member");
}

const createTask = asyncHandler(async (req, res) => {
  const { roomId, sourceMessageId, decisionId = null, assigneeId = null, clientId = null } = req.body || {};
  if (!UUID_RE.test(roomId) || sourceMessageId && !UUID_RE.test(sourceMessageId))
    throw new ApiError(400, "Invalid conversation or source message");
  if (decisionId !== null && !UUID_RE.test(decisionId))
    throw new ApiError(400, "Invalid decision");
  if (clientId !== null && !UUID_RE.test(clientId))
    throw new ApiError(400, "Invalid task creation identifier");
  const title = validateTitle(req.body.title);
  const body = validateBody(req.body.body);
  const dueDate = validateDate(req.body.dueDate);
  const client = await pool.connect();
  let taskId; let newlyCreated = true;
  try {
    await client.query("BEGIN");
    const room = await client.query(
      `SELECT r.encryption_mode FROM rooms r JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$2
       WHERE r.id=$1 FOR SHARE OF rm`, [roomId, req.user.id],
    );
    if (!room.rowCount) throw new ApiError(403, "Conversation unavailable");
    if (room.rows[0].encryption_mode === "e2ee-v1")
      throw new ApiError(409, "Tasks are unavailable in encrypted conversations");
    if (clientId) {
      const prior = await client.query(
        "SELECT id,room_id FROM tasks WHERE created_by=$1 AND client_id=$2",
        [req.user.id, clientId],
      );
      if (prior.rowCount) {
        if (prior.rows[0].room_id !== roomId) throw new ApiError(409, "Task creation identifier was used in another conversation");
        taskId = prior.rows[0].id;
        newlyCreated = false;
      }
    }
    if (newlyCreated) {
    await checkAssignee(client, roomId, assigneeId);
    if (decisionId) {
      const linked = await client.query(
        "SELECT 1 FROM decisions WHERE id=$1 AND room_id=$2 AND status='active' FOR SHARE",
        [decisionId, roomId],
      );
      if (!linked.rowCount) throw new ApiError(400, "Choose an active decision from this conversation");
    }
    if (sourceMessageId) {
      const source = await client.query(
        `SELECT 1 FROM messages m WHERE m.id=$1 AND m.room_id=$2 AND m.deleted_at IS NULL
         AND message_visible(m.id,$3)`, [sourceMessageId, roomId, req.user.id],
      );
      if (!source.rowCount) throw new ApiError(400, "Choose a visible message from this conversation");
    }
    const inserted = await client.query(
      `INSERT INTO tasks (room_id,source_message_id,title,body,assignee_id,due_date,created_by,client_id,decision_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (created_by,client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING id`,
      [roomId, sourceMessageId || null, title, body, assigneeId, dueDate, req.user.id, clientId, decisionId],
    );
    if (inserted.rowCount) taskId = inserted.rows[0].id;
    else {
      const prior = await client.query("SELECT id,room_id FROM tasks WHERE created_by=$1 AND client_id=$2",
        [req.user.id, clientId]);
      if (!prior.rowCount || prior.rows[0].room_id !== roomId)
        throw new ApiError(409, "Task creation identifier was used in another conversation");
      taskId = prior.rows[0].id;
      newlyCreated = false;
    }
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  const task = await payload(taskId, req.user.id);
  const io = req.app.get("io");
  if (newlyCreated) {
    await publish(io, task);
    await notifyAssignee(io, task, req.user.id);
  }
  return ok(res, task, 201);
});

const listTasks = asyncHandler(async (req, res) => {
  const { roomId, status, assigneeId, decisionId, before } = req.query;
  if (roomId && !UUID_RE.test(roomId)) throw new ApiError(400, "Invalid conversation");
  if (status && !STATUSES.includes(status)) throw new ApiError(400, "Invalid task status");
  if (assigneeId && !UUID_RE.test(assigneeId)) throw new ApiError(400, "Invalid assignee");
  if (decisionId && !UUID_RE.test(decisionId)) throw new ApiError(400, "Invalid decision");
  const params = [req.user.id];
  const where = [];
  if (roomId) { params.push(roomId); where.push(`t.room_id=$${params.length}`); }
  if (status) { params.push(status); where.push(`t.status=$${params.length}`); }
  if (assigneeId) { params.push(assigneeId); where.push(`t.assignee_id=$${params.length}`); }
  if (decisionId) { params.push(decisionId); where.push(`t.decision_id=$${params.length}`); }
  if (before) {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(before, "base64url").toString("utf8")); }
    catch { throw new ApiError(400, "Invalid task cursor"); }
    if (!Number.isFinite(Date.parse(cursor?.created_at)) || !UUID_RE.test(cursor?.id) ||
        cursor.due_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(cursor.due_date))
      throw new ApiError(400, "Invalid task cursor");
    params.push(cursor.created_at, cursor.id);
    const tie = `(t.created_at,t.id)<($${params.length - 1}::timestamptz,$${params.length}::uuid)`;
    if (cursor.due_date === null) where.push(`t.due_date IS NULL AND ${tie}`);
    else {
      params.push(cursor.due_date);
      where.push(`(t.due_date>$${params.length}::date OR t.due_date IS NULL OR
        (t.due_date=$${params.length}::date AND ${tie}))`);
    }
  }
  params.push(PAGE_SIZE + 1);
  const result = await query(
    `SELECT ${COLUMNS} ${JOINS} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY t.due_date ASC NULLS LAST,t.created_at DESC,t.id DESC LIMIT $${params.length}`, params,
  );
  const tasks = result.rows.slice(0, PAGE_SIZE);
  const last = tasks.at(-1);
  return ok(res, { tasks, nextCursor: result.rowCount > PAGE_SIZE
    ? Buffer.from(JSON.stringify({ due_date: last.due_date, created_at: last.created_at, id: last.id })).toString("base64url") : null });
});

const getTask = asyncHandler(async (req, res) => {
  const task = await payload(req.params.taskId, req.user.id);
  if (!task) throw new ApiError(404, "Task not found");
  let cursorSql = "";
  const params = [task.id];
  if (req.query.before) {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(req.query.before, "base64url").toString("utf8")); }
    catch { throw new ApiError(400, "Invalid activity cursor"); }
    if (!Number.isFinite(Date.parse(cursor?.created_at)) || !UUID_RE.test(cursor?.id))
      throw new ApiError(400, "Invalid activity cursor");
    params.push(cursor.created_at, cursor.id);
    cursorSql = " AND (tu.created_at,tu.id)<($2::timestamptz,$3::uuid)";
  }
  const updates = await query(
    `SELECT tu.id,tu.kind,tu.body,tu.old_status,tu.new_status,tu.created_at,
      u.display_name AS author_name FROM task_updates tu JOIN users u ON u.id=tu.author_id
      WHERE tu.task_id=$1${cursorSql} ORDER BY tu.created_at DESC,tu.id DESC LIMIT 21`, params,
  );
  const page = updates.rows.slice(0, 20);
  const last = page.at(-1);
  return ok(res, { task, updates: page, nextCursor: updates.rowCount > 20
    ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString("base64url") : null });
});

const updateTaskStatus = asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) throw new ApiError(400, "Invalid task status");
  const client = await pool.connect();
  let task;
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT t.status,t.assignee_id FROM tasks t JOIN room_members rm
       ON rm.room_id=t.room_id AND rm.user_id=$2 WHERE t.id=$1 FOR UPDATE OF t, rm`,
      [req.params.taskId, req.user.id],
    );
    if (!current.rowCount) throw new ApiError(404, "Task not found");
    if (current.rows[0].assignee_id !== req.user.id)
      throw new ApiError(403, "Only the assigned member can change progress");
    if (current.rows[0].status !== status) {
      await client.query("UPDATE tasks SET status=$2,updated_at=NOW() WHERE id=$1",
        [req.params.taskId, status]);
      await client.query(
        `INSERT INTO task_updates(task_id,author_id,kind,old_status,new_status)
         VALUES($1,$2,'status',$3,$4)`,
        [req.params.taskId, req.user.id, current.rows[0].status, status],
      );
    }
    task = await payload(req.params.taskId, req.user.id, client);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await publish(req.app.get("io"), task);
  return ok(res, task);
});

const addTaskUpdate = asyncHandler(async (req, res) => {
  const body = req.body?.body;
  if (typeof body !== "string" || body.trim().length < 1 || body.trim().length > 2000)
    throw new ApiError(400, "Progress note must be 1–2,000 characters");
  const client = await pool.connect();
  let task;
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT t.assignee_id FROM tasks t JOIN room_members rm
       ON rm.room_id=t.room_id AND rm.user_id=$2 WHERE t.id=$1 FOR UPDATE OF t, rm`,
      [req.params.taskId, req.user.id],
    );
    if (!current.rowCount) throw new ApiError(404, "Task not found");
    if (current.rows[0].assignee_id !== req.user.id)
      throw new ApiError(403, "Only the assigned member can add progress notes");
    await client.query("INSERT INTO task_updates(task_id,author_id,kind,body) VALUES($1,$2,'note',$3)",
      [req.params.taskId, req.user.id, body.trim()]);
    await client.query("UPDATE tasks SET updated_at=NOW() WHERE id=$1", [req.params.taskId]);
    task = await payload(req.params.taskId, req.user.id, client);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await publish(req.app.get("io"), task);
  return ok(res, task, 201);
});

const editTask = asyncHandler(async (req, res) => {
  const { title, body, dueDate, assigneeId } = req.body || {};
  const fields = {
    title: validateTitle(title), body: validateBody(body),
    dueDate: validateDate(dueDate), assigneeId: assigneeId || null,
  };
  const client = await pool.connect();
  let task; let previousAssignee;
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT t.room_id,t.assignee_id,t.created_by,rm.role FROM tasks t
       JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=$2
       WHERE t.id=$1 FOR UPDATE OF t, rm`, [req.params.taskId, req.user.id],
    );
    if (!current.rowCount) throw new ApiError(404, "Task not found");
    const row = current.rows[0];
    if (row.created_by !== req.user.id && row.role !== "admin")
      throw new ApiError(403, "Only the creator or room admin can edit task details");
    await checkAssignee(client, row.room_id, fields.assigneeId);
    previousAssignee = row.assignee_id;
    await client.query(
      `UPDATE tasks SET title=$2,body=$3,due_date=$4,assignee_id=$5,updated_at=NOW()
       WHERE id=$1`, [req.params.taskId, fields.title, fields.body, fields.dueDate, fields.assigneeId],
    );
    await client.query(
      `INSERT INTO task_updates(task_id,author_id,kind,body) VALUES($1,$2,'details',$3)`,
      [req.params.taskId, req.user.id,
        previousAssignee !== fields.assigneeId ? "Assignment and task details updated" : "Task details updated"],
    );
    task = await payload(req.params.taskId, req.user.id, client);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  const io = req.app.get("io");
  await publish(io, task);
  if (previousAssignee !== task.assignee_id) await notifyAssignee(io, task, req.user.id);
  return ok(res, task);
});

module.exports = { createTask, listTasks, getTask, updateTaskStatus, addTaskUpdate, editTask, STATUSES };
