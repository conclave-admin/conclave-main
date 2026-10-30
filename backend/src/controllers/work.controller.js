const { pool, query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { ok } = require("../utils/apiResponse");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = (value) => value == null || value === "" ? null :
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value :
    (() => { throw new ApiError(400, "Invalid date"); })();
const text = (value, max, label, required = false) => {
  if (typeof value !== "string" || value.trim().length > max || required && !value.trim())
    throw new ApiError(400, `${label} must be ${required ? "1–" : "at most "}${max} characters`);
  return value.trim();
};
const uuid = (value, label) => {
  if (!UUID.test(value)) throw new ApiError(400, `Invalid ${label}`);
  return value;
};
async function transaction(fn) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const value = await fn(db);
    await db.query("COMMIT");
    return value;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}
async function member(db, roomId, userId, admin = false) {
  const result = await db.query(
    "SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE",
    [roomId, userId]);
  if (!result.rowCount) throw new ApiError(403, "Conversation unavailable");
  if (admin && result.rows[0].role !== "admin") throw new ApiError(403, "Room admin required");
}
async function project(db, projectId, userId, manage = false) {
  const result = await db.query(
    `SELECT p.* FROM projects p WHERE p.id=$1 AND
     (p.created_by=$2 OR EXISTS (SELECT 1 FROM project_rooms pr JOIN room_members rm
       ON rm.room_id=pr.room_id AND rm.user_id=$2 WHERE pr.project_id=p.id))`,
    [projectId, userId]);
  if (!result.rowCount) throw new ApiError(404, "Project unavailable");
  if (manage && result.rows[0].created_by !== userId)
    throw new ApiError(403, "Only the project creator can manage it");
  return result.rows[0];
}
async function plainRoom(db, roomId) {
  const room = await db.query("SELECT encryption_mode FROM rooms WHERE id=$1", [roomId]);
  if (!room.rowCount) throw new ApiError(404, "Conversation unavailable");
  if (room.rows[0].encryption_mode === "e2ee-v1")
    throw new ApiError(409, "Server-readable work is unavailable in encrypted conversations");
}

const listProjects = asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT p.id,p.name,p.description,p.status,p.created_by,p.updated_at,
       COUNT(DISTINCT pr.room_id) FILTER (WHERE rm.user_id IS NOT NULL)::int AS room_count
     FROM projects p LEFT JOIN project_rooms pr ON pr.project_id=p.id
     LEFT JOIN room_members rm ON rm.room_id=pr.room_id AND rm.user_id=$1
     WHERE p.created_by=$1 OR rm.user_id IS NOT NULL
     GROUP BY p.id ORDER BY p.updated_at DESC,p.id DESC LIMIT 100`, [req.user.id]);
  return ok(res, { projects: rows.rows });
});

const createProject = asyncHandler(async (req, res) => {
  const name = text(req.body?.name, 160, "Project name", true);
  const description = text(req.body?.description || "", 2000, "Description");
  const roomIds = req.body?.roomIds;
  if (!Array.isArray(roomIds) || !roomIds.length || roomIds.length > 20 ||
      new Set(roomIds).size !== roomIds.length) throw new ApiError(400, "Choose 1–20 distinct conversations");
  roomIds.forEach((id) => uuid(id, "conversation"));
  const result = await transaction(async (db) => {
    for (const roomId of roomIds) { await member(db, roomId, req.user.id, true); await plainRoom(db, roomId); }
    const p = (await db.query(
      "INSERT INTO projects(name,description,created_by) VALUES($1,$2,$3) RETURNING *",
      [name, description, req.user.id])).rows[0];
    for (const roomId of roomIds) {
      await db.query("INSERT INTO project_rooms(project_id,room_id) VALUES($1,$2)", [p.id, roomId]);
      await db.query("UPDATE tasks SET project_id=$1 WHERE room_id=$2", [p.id, roomId]);
    }
    return p;
  });
  return ok(res, result, 201);
});

const getProject = asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  const p = await project({ query }, projectId, req.user.id);
  const rooms = await query(
    `SELECT r.id,r.name,r.slug,rm.role FROM project_rooms pr JOIN rooms r ON r.id=pr.room_id
     JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$2
     WHERE pr.project_id=$1 ORDER BY r.name`, [projectId, req.user.id]);
  const milestones = await query(
    `SELECT pm.id,pm.title,to_char(pm.due_date,'YYYY-MM-DD') AS due_date,pm.completed_at,
       COUNT(t.id)::int AS total_tasks,
       COUNT(t.id) FILTER (WHERE t.status='done')::int AS done_tasks
     FROM project_milestones pm LEFT JOIN tasks t ON t.milestone_id=pm.id
       AND EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=t.room_id AND rm.user_id=$2)
     WHERE pm.project_id=$1 GROUP BY pm.id ORDER BY pm.due_date NULLS LAST,pm.created_at`,
    [projectId, req.user.id]);
  const tasks = await query(
    `SELECT t.id,t.room_id,t.title,t.status,t.assignee_id,t.created_by,u.display_name AS assignee_name,
       to_char(t.due_date,'YYYY-MM-DD') AS due_date,t.milestone_id,r.name AS room_name,
       COUNT(dep.depends_on_id) FILTER (WHERE blocker.status<>'done')::int AS open_blockers
     FROM tasks t JOIN rooms r ON r.id=t.room_id
     JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=$2
     LEFT JOIN users u ON u.id=t.assignee_id
     LEFT JOIN task_dependencies dep ON dep.task_id=t.id
     LEFT JOIN tasks blocker ON blocker.id=dep.depends_on_id
     WHERE t.project_id=$1 GROUP BY t.id,u.display_name,r.name
     ORDER BY t.due_date NULLS LAST,t.created_at DESC LIMIT 200`, [projectId, req.user.id]);
  const decisions = await query(
    `SELECT d.id,d.room_id,d.title,d.status,d.updated_at,r.name AS room_name
     FROM decisions d JOIN project_rooms pr ON pr.room_id=d.room_id AND pr.project_id=$1
     JOIN room_members rm ON rm.room_id=d.room_id AND rm.user_id=$2
     JOIN rooms r ON r.id=d.room_id ORDER BY d.updated_at DESC LIMIT 50`, [projectId, req.user.id]);
  const dependencies = await query(
    `SELECT dep.task_id,dep.depends_on_id,blocker.title AS blocker_title
     FROM task_dependencies dep JOIN tasks task ON task.id=dep.task_id
     JOIN tasks blocker ON blocker.id=dep.depends_on_id
     JOIN room_members viewer ON viewer.room_id=task.room_id AND viewer.user_id=$2
     JOIN room_members other_viewer ON other_viewer.room_id=blocker.room_id AND other_viewer.user_id=$2
     WHERE task.project_id=$1 AND blocker.project_id=$1 ORDER BY dep.created_at DESC LIMIT 500`,
    [projectId, req.user.id]);
  const report = await query(
    `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE t.status='done')::int AS done,
       COUNT(*) FILTER (WHERE t.status<>'done' AND t.due_date<CURRENT_DATE)::int AS overdue,
       COUNT(*) FILTER (WHERE t.status<>'done' AND t.assignee_id IS NULL)::int AS unassigned,
       COUNT(*) FILTER (WHERE t.status<>'done' AND EXISTS
         (SELECT 1 FROM task_dependencies dep JOIN tasks blocker ON blocker.id=dep.depends_on_id
          WHERE dep.task_id=t.id AND blocker.status<>'done'))::int AS blocked
     FROM tasks t JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=$2
     WHERE t.project_id=$1`, [projectId, req.user.id]);
  return ok(res, { project: p, rooms: rooms.rows, milestones: milestones.rows,
    tasks: tasks.rows, decisions: decisions.rows, dependencies: dependencies.rows, report: report.rows[0],
    truncated: tasks.rowCount === 200 || decisions.rowCount === 50 });
});

const updateProject = asyncHandler(async (req, res) => {
  await project({ query }, req.params.projectId, req.user.id, true);
  const name = text(req.body?.name, 160, "Project name", true);
  const description = text(req.body?.description || "", 2000, "Description");
  const status = req.body?.status;
  if (!["active", "completed", "archived"].includes(status)) throw new ApiError(400, "Invalid project status");
  const row = await query(
    "UPDATE projects SET name=$2,description=$3,status=$4,updated_at=NOW() WHERE id=$1 RETURNING *",
    [req.params.projectId, name, description, status]);
  return ok(res, row.rows[0]);
});

const addProjectRoom = asyncHandler(async (req, res) => {
  const roomId = uuid(req.body?.roomId, "conversation");
  await transaction(async (db) => {
    await project(db, req.params.projectId, req.user.id, true);
    await member(db, roomId, req.user.id, true);
    await plainRoom(db, roomId);
    await db.query("INSERT INTO project_rooms(project_id,room_id) VALUES($1,$2)",
      [req.params.projectId, roomId]);
    await db.query("UPDATE tasks SET project_id=$1 WHERE room_id=$2", [req.params.projectId, roomId]);
  });
  return ok(res, { roomId }, 201);
});

const removeProjectRoom = asyncHandler(async (req, res) => {
  const { projectId, roomId } = req.params;
  await transaction(async (db) => {
    await project(db, projectId, req.user.id, true);
    await member(db, roomId, req.user.id, true);
    await db.query("DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE room_id=$1) OR depends_on_id IN (SELECT id FROM tasks WHERE room_id=$1)", [roomId]);
    await db.query("UPDATE tasks SET milestone_id=NULL,project_id=NULL WHERE room_id=$1 AND project_id=$2", [roomId, projectId]);
    await db.query("DELETE FROM project_rooms WHERE project_id=$1 AND room_id=$2", [projectId, roomId]);
  });
  return ok(res, { roomId });
});

const createMilestone = asyncHandler(async (req, res) => {
  await project({ query }, req.params.projectId, req.user.id, true);
  const title = text(req.body?.title, 160, "Milestone title", true);
  const dueDate = date(req.body?.dueDate);
  const row = await query(
    "INSERT INTO project_milestones(project_id,title,due_date,created_by) VALUES($1,$2,$3,$4) RETURNING *",
    [req.params.projectId, title, dueDate, req.user.id]);
  return ok(res, row.rows[0], 201);
});

const updateMilestone = asyncHandler(async (req, res) => {
  await project({ query }, req.params.projectId, req.user.id, true);
  const title = text(req.body?.title, 160, "Milestone title", true);
  const dueDate = date(req.body?.dueDate);
  const completed = req.body?.completed;
  if (typeof completed !== "boolean") throw new ApiError(400, "Invalid completion state");
  const row = await query(
    `UPDATE project_milestones SET title=$3,due_date=$4,
     completed_at=CASE WHEN $5 THEN COALESCE(completed_at,NOW()) ELSE NULL END
     WHERE id=$1 AND project_id=$2 RETURNING *`,
    [req.params.milestoneId, req.params.projectId, title, dueDate, completed]);
  if (!row.rowCount) throw new ApiError(404, "Milestone unavailable");
  return ok(res, row.rows[0]);
});

async function managedTask(db, taskId, userId) {
  const result = await db.query(
    `SELECT t.id,t.project_id,t.room_id,t.created_by,rm.role FROM tasks t
     JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=$2
     WHERE t.id=$1 FOR UPDATE OF t`, [taskId, userId]);
  if (!result.rowCount) throw new ApiError(404, "Task unavailable");
  const task = result.rows[0];
  if (task.created_by !== userId && task.role !== "admin")
    throw new ApiError(403, "Only the task creator or room admin can organize this task");
  if (!task.project_id) throw new ApiError(409, "Add this conversation to a project first");
  return task;
}
const setTaskMilestone = asyncHandler(async (req, res) => {
  const milestoneId = req.body?.milestoneId;
  if (milestoneId !== null) uuid(milestoneId, "milestone");
  const task = await transaction(async (db) => {
    const current = await managedTask(db, req.params.taskId, req.user.id);
    if (milestoneId) {
      const found = await db.query("SELECT 1 FROM project_milestones WHERE id=$1 AND project_id=$2",
        [milestoneId, current.project_id]);
      if (!found.rowCount) throw new ApiError(400, "Milestone belongs to another project");
    }
    return (await db.query("UPDATE tasks SET milestone_id=$2,updated_at=NOW() WHERE id=$1 RETURNING *",
      [current.id, milestoneId])).rows[0];
  });
  return ok(res, task);
});

const addDependency = asyncHandler(async (req, res) => {
  const dependsOnId = uuid(req.body?.dependsOnId, "dependency");
  if (dependsOnId === req.params.taskId) throw new ApiError(400, "A task cannot depend on itself");
  await transaction(async (db) => {
    const task = await managedTask(db, req.params.taskId, req.user.id);
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [task.project_id]);
    const other = await db.query(
      `SELECT t.id FROM tasks t JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=$3
       WHERE t.id=$1 AND t.project_id=$2`, [dependsOnId, task.project_id, req.user.id]);
    if (!other.rowCount) throw new ApiError(400, "Dependency must be visible in this project");
    const cycle = await db.query(
      `WITH RECURSIVE chain(id) AS (
         SELECT $1::uuid UNION SELECT td.depends_on_id FROM task_dependencies td JOIN chain c ON c.id=td.task_id
       ) SELECT 1 FROM chain WHERE id=$2 LIMIT 1`, [dependsOnId, task.id]);
    if (cycle.rowCount) throw new ApiError(409, "This dependency would create a cycle");
    await db.query("INSERT INTO task_dependencies(task_id,depends_on_id,created_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [task.id, dependsOnId, req.user.id]);
  });
  return ok(res, { taskId: req.params.taskId, dependsOnId }, 201);
});
const removeDependency = asyncHandler(async (req, res) => {
  await transaction(async (db) => {
    await managedTask(db, req.params.taskId, req.user.id);
    await db.query("DELETE FROM task_dependencies WHERE task_id=$1 AND depends_on_id=$2",
      [req.params.taskId, req.params.dependsOnId]);
  });
  return ok(res, { taskId: req.params.taskId, dependsOnId: req.params.dependsOnId });
});

const getBrief = asyncHandler(async (req, res) => {
  await member({ query }, req.params.roomId, req.user.id);
  await plainRoom({ query }, req.params.roomId);
  const brief = await query(
    `SELECT b.*,u.display_name AS editor_name FROM room_briefs b
     JOIN users u ON u.id=b.updated_by WHERE b.room_id=$1`, [req.params.roomId]);
  const revisions = await query(
    `SELECT br.version,br.body,br.source_message_id,br.changed_at,u.display_name AS editor_name FROM room_brief_revisions br
     JOIN users u ON u.id=br.changed_by WHERE br.room_id=$1 ORDER BY br.version DESC LIMIT 20`,
    [req.params.roomId]);
  return ok(res, { brief: brief.rows[0] || null, revisions: revisions.rows });
});
const putBrief = asyncHandler(async (req, res) => {
  const body = text(req.body?.body, 10000, "Brief");
  const sourceId = req.body?.sourceMessageId || null;
  if (sourceId) uuid(sourceId, "source message");
  if (req.body?.version != null && (!Number.isInteger(req.body.version) || req.body.version < 1))
    throw new ApiError(400, "Invalid brief version");
  const brief = await transaction(async (db) => {
    await member(db, req.params.roomId, req.user.id, true);
    await plainRoom(db, req.params.roomId);
    if (sourceId) {
      const source = await db.query(
        "SELECT 1 FROM messages WHERE id=$1 AND room_id=$2 AND deleted_at IS NULL AND message_visible(id,$3)",
        [sourceId, req.params.roomId, req.user.id]);
      if (!source.rowCount) throw new ApiError(400, "Source message unavailable");
    }
    const current = await db.query("SELECT version FROM room_briefs WHERE room_id=$1 FOR UPDATE", [req.params.roomId]);
    if (current.rowCount && current.rows[0].version !== req.body.version)
      throw new ApiError(409, "Brief changed on another device. Reload before saving.");
    if (!current.rowCount && req.body.version != null)
      throw new ApiError(409, "Brief changed on another device. Reload before saving.");
    const row = current.rowCount
      ? await db.query("UPDATE room_briefs SET body=$2,source_message_id=$3,version=version+1,updated_by=$4,updated_at=NOW() WHERE room_id=$1 RETURNING *",
        [req.params.roomId, body, sourceId, req.user.id])
      : await db.query("INSERT INTO room_briefs(room_id,body,source_message_id,updated_by) VALUES($1,$2,$3,$4) RETURNING *",
        [req.params.roomId, body, sourceId, req.user.id]);
    const saved = row.rows[0];
    await db.query("INSERT INTO room_brief_revisions(room_id,version,body,source_message_id,changed_by) VALUES($1,$2,$3,$4,$5)",
      [saved.room_id, saved.version, saved.body, saved.source_message_id, req.user.id]);
    return saved;
  });
  return ok(res, brief);
});

module.exports = { listProjects, createProject, getProject, updateProject,
  addProjectRoom, removeProjectRoom, createMilestone, updateMilestone,
  setTaskMilestone, addDependency, removeDependency, getBrief, putBrief,
  project, member, text, uuid };
