const { pool, query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const ApiError = require('../utils/ApiError');

const STATUSES = ['open', 'in_progress', 'done'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;
// Keep calendar dates as dates: node-postgres otherwise converts DATE to a
// local-midnight Date, which can serialize as the previous day in UTC.
const TASK_SELECT = `SELECT t.id, t.room_id, t.source_message_id, t.title,
                           t.assignee_id, t.status, to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
                           t.created_by, t.created_at, t.updated_at,
                           r.name AS room_name, r.slug AS room_slug,
                           u.display_name AS assignee_name
                      FROM tasks t
                      JOIN rooms r ON r.id = t.room_id
                      LEFT JOIN users u ON u.id = t.assignee_id`;

function uuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ApiError(400, `${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function statusValue(value) {
  if (!STATUSES.includes(value)) throw new ApiError(400, `status must be one of: ${STATUSES.join(', ')}`);
  return value;
}

function dateValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) {
    throw new ApiError(400, 'dueDate must be a calendar date in YYYY-MM-DD format');
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, 'dueDate must be a valid calendar date');
  }
  return value;
}

async function requireMember(client, roomId, userId, lock = false) {
  const { rows } = await client.query(
    `SELECT rm.role FROM room_members rm JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = $1 AND rm.user_id = $2 AND u.deleted_at IS NULL
      ${lock ? 'FOR SHARE OF rm, u' : ''}`, [roomId, userId],
  );
  if (!rows.length) throw new ApiError(403, 'You are not a member of this room');
}

function emitTask(req, event, task) {
  // Emit only committed rows. A transient delivery failure must not make the
  // caller retry an already-persisted mutation; lists remain the source of truth.
  try {
    req.app.get('io')?.to(task.room_id).emit(event, { task });
  } catch (error) {
    console.error('Could not broadcast task event', error);
  }
}

const createTask = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const roomId = uuid(body.roomId, 'roomId');
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 200) {
    throw new ApiError(400, 'title must contain between 1 and 200 characters');
  }
  const assigneeId = body.assigneeId == null ? null : uuid(body.assigneeId, 'assigneeId');
  const sourceMessageId = body.sourceMessageId == null ? null : uuid(body.sourceMessageId, 'sourceMessageId');
  const dueDate = dateValue(body.dueDate);
  const client = await pool.connect();
  let task;
  try {
    await client.query('BEGIN');
    await requireMember(client, roomId, req.user.id, true);
    if (assigneeId) {
      const member = await client.query(
        `SELECT 1 FROM room_members rm JOIN users u ON u.id = rm.user_id
          WHERE rm.room_id = $1 AND rm.user_id = $2 AND u.deleted_at IS NULL
          FOR SHARE OF rm, u`, [roomId, assigneeId],
      );
      if (!member.rows.length) throw new ApiError(400, 'assigneeId must identify an active member of this room');
    }
    if (sourceMessageId) {
      const source = await client.query(
        `SELECT id FROM messages WHERE id = $1 AND room_id = $2 AND deleted_at IS NULL FOR SHARE`,
        [sourceMessageId, roomId],
      );
      if (!source.rows.length) throw new ApiError(400, 'Source message is unavailable in this room');
    }
    const inserted = await client.query(
      `INSERT INTO tasks (room_id, title, assignee_id, due_date, source_message_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [roomId, body.title.trim(), assigneeId, dueDate, sourceMessageId, req.user.id],
    );
    const result = await client.query(`${TASK_SELECT} WHERE t.id = $1`, [inserted.rows[0].id]);
    task = result.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  emitTask(req, 'task:created', task);
  return ok(res, task, 201);
});

const listTasks = asyncHandler(async (req, res) => {
  const filters = req.query || {};
  const routeRoomId = req.params.roomId;
  const roomId = routeRoomId ? uuid(routeRoomId, 'roomId')
    : filters.roomId === undefined ? null : uuid(filters.roomId, 'roomId');
  if (routeRoomId && filters.roomId !== undefined && uuid(filters.roomId, 'roomId') !== roomId) {
    throw new ApiError(400, 'roomId filter must match the room in the URL');
  }
  const status = filters.status === undefined ? null : statusValue(filters.status);
  const assignee = filters.assigneeId === undefined ? null
    : filters.assigneeId === 'me' ? req.user.id : uuid(filters.assigneeId, 'assigneeId');
  const params = [req.user.id];
  const conditions = ['EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = t.room_id AND rm.user_id = $1)'];
  const add = (expression, value) => { params.push(value); conditions.push(`${expression} $${params.length}`); };
  if (roomId) add('t.room_id =', roomId);
  if (status) add('t.status =', status);
  if (assignee) add('t.assignee_id =', assignee);
  if (filters.before !== undefined) {
    const parts = typeof filters.before === 'string' ? filters.before.split('|') : [];
    const parsed = new Date(parts[0]);
    if (parts.length !== 2 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(parts[0])
        || parts[0].startsWith('0000') || !Number.isFinite(parsed.getTime())
        || parsed.toISOString().slice(0, 19) !== parts[0].slice(0, 19)) {
      throw new ApiError(400, 'Invalid task cursor');
    }
    const id = uuid(parts[1], 'cursor task ID');
    params.push(parts[0], id);
    conditions.push(`(t.created_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  if (roomId) await requireMember({ query }, roomId, req.user.id);
  // Preserve PostgreSQL microseconds in the cursor; JS Date truncates them and
  // can skip tasks created within the same millisecond at a page boundary.
  const { rows } = await query(
    `SELECT listed.*,
            to_char(listed.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
       FROM (${TASK_SELECT} WHERE ${conditions.join(' AND ')}
             ORDER BY t.created_at DESC, t.id DESC LIMIT ${PAGE_SIZE + 1}) listed
       ORDER BY listed.created_at DESC, listed.id DESC`, params,
  );
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  const nextCursor = rows.length > PAGE_SIZE ? `${last.cursor_time}|${last.id}` : null;
  return ok(res, { tasks: page.map(({ cursor_time, ...task }) => task), nextCursor });
});

const updateTaskStatus = asyncHandler(async (req, res) => {
  const taskId = uuid(req.params.taskId, 'taskId');
  const status = statusValue(req.body?.status);
  const client = await pool.connect();
  let task;
  let changed = false;
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT t.*, rm.role FROM tasks t
       JOIN room_members rm ON rm.room_id = t.room_id AND rm.user_id = $2
       WHERE t.id = $1 FOR UPDATE OF t FOR SHARE OF rm`, [taskId, req.user.id],
    );
    if (!current.rows.length) throw new ApiError(404, 'Task not found');
    const row = current.rows[0];
    if (row.created_by !== req.user.id && row.assignee_id !== req.user.id && row.role !== 'admin') {
      throw new ApiError(403, 'Only the task creator, assignee, or room admin can change its status');
    }
    changed = row.status !== status;
    if (changed) {
      await client.query('UPDATE tasks SET status = $2, updated_at = clock_timestamp() WHERE id = $1', [taskId, status]);
    }
    const result = await client.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
    task = result.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (changed) emitTask(req, 'task:updated', task);
  return ok(res, task);
});

module.exports = { createTask, listTasks, updateTaskStatus };
