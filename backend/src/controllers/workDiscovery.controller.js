const { query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { ok } = require("../utils/apiResponse");
const { project, text } = require("./work.controller");

const search = asyncHandler(async (req, res) => {
  const q = text(req.query.q, 100, "Search query", true);
  if (q.length < 2) throw new ApiError(400, "Search needs at least two characters");
  const userId = req.user.id;
  const params = [userId, q];
  const searches = [
    query(`SELECT 'message' AS type,m.id,m.room_id,r.name AS room_name,
      LEFT(m.content,220) AS title,m.created_at
      FROM messages m JOIN rooms r ON r.id=m.room_id
      JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=$1
      WHERE r.encryption_mode<>'e2ee-v1' AND m.deleted_at IS NULL
      AND message_visible(m.id,$1) AND position(lower($2) in lower(m.content))>0
      ORDER BY m.created_at DESC LIMIT 15`, params),
    query(`SELECT 'decision' AS type,d.id,d.room_id,r.name AS room_name,
      d.title,d.created_at FROM decisions d JOIN rooms r ON r.id=d.room_id
      JOIN room_members rm ON rm.room_id=d.room_id AND rm.user_id=$1
      WHERE position(lower($2) in lower(d.title||' '||COALESCE(d.body,'')))>0
      ORDER BY d.created_at DESC LIMIT 15`, params),
    query(`SELECT 'task' AS type,t.id,t.room_id,r.name AS room_name,
      t.title,t.created_at FROM tasks t JOIN rooms r ON r.id=t.room_id
      JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=$1
      WHERE position(lower($2) in lower(t.title||' '||COALESCE(t.body,'')))>0
      ORDER BY t.created_at DESC LIMIT 15`, params),
    query(`SELECT 'file' AS type,a.id,m.room_id,r.name AS room_name,
      COALESCE(a.filename,'Shared file') AS title,a.created_at,m.id AS message_id
      FROM attachments a JOIN messages m ON m.id=a.message_id
      JOIN rooms r ON r.id=m.room_id
      JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=$1
      WHERE r.encryption_mode<>'e2ee-v1' AND m.deleted_at IS NULL
      AND message_visible(m.id,$1)
      AND position(lower($2) in lower(COALESCE(a.filename,'')))>0
      ORDER BY a.created_at DESC LIMIT 15`, params),
    query(`SELECT 'room' AS type,r.id,r.id AS room_id,r.name AS room_name,
      r.name AS title,r.created_at FROM rooms r JOIN room_members rm
      ON rm.room_id=r.id AND rm.user_id=$1
      WHERE position(lower($2) in lower(r.name))>0
      ORDER BY r.created_at DESC LIMIT 15`, params),
    query(`SELECT 'person' AS type,u.id,NULL::uuid AS room_id,NULL::text AS room_name,
      u.display_name AS title,u.created_at FROM users u
      WHERE u.deleted_at IS NULL AND position(lower($2) in lower(u.display_name))>0
      AND EXISTS(SELECT 1 FROM room_members a JOIN room_members b ON b.room_id=a.room_id
        WHERE a.user_id=$1 AND b.user_id=u.id)
      ORDER BY u.created_at DESC LIMIT 15`, params),
  ];
  const results = await Promise.all(searches);
  const items = results.flatMap((result) => result.rows)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 50);
  return ok(res, { items, hasMore: results.some((result) => result.rowCount === 15) });
});

const inbox = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const rows = await query(
    `WITH candidates AS (
       SELECT ('assignment:'||t.id::text) AS event_key,'assignment' AS type,t.id,
         t.room_id,r.name AS room_name,t.title,t.updated_at AS occurred_at,
         t.due_date,0 AS priority
       FROM tasks t JOIN rooms r ON r.id=t.room_id
       JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=$1
       WHERE t.assignee_id=$1 AND t.status<>'done'
       UNION ALL
       SELECT ('mention:'||m.id::text),'mention',m.id,m.room_id,r.name,
         CASE WHEN r.encryption_mode='e2ee-v1' THEN 'Mentioned you' ELSE LEFT(m.content,160) END,
         m.created_at,NULL::date,0
       FROM message_mentions mm JOIN messages m ON m.id=mm.message_id
       JOIN rooms r ON r.id=m.room_id
       JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=$1
       WHERE mm.user_id=$1 AND m.sender_id<>$1 AND m.deleted_at IS NULL AND message_visible(m.id,$1)
       UNION ALL
       SELECT ('blocked:'||t.id::text),'blocked',t.id,t.room_id,r.name,t.title,
         t.updated_at,t.due_date,1
       FROM tasks t JOIN rooms r ON r.id=t.room_id
       JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=$1
       WHERE t.status<>'done' AND (t.assignee_id=$1 OR t.created_by=$1)
         AND EXISTS(SELECT 1 FROM task_dependencies dep JOIN tasks blocker ON blocker.id=dep.depends_on_id
           WHERE dep.task_id=t.id AND blocker.status<>'done')
       UNION ALL
       SELECT ('overdue:'||t.id::text||':'||t.due_date::text),'overdue',t.id,t.room_id,r.name,
         t.title,t.updated_at,t.due_date,0
       FROM tasks t JOIN rooms r ON r.id=t.room_id
       JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=$1
       WHERE t.assignee_id=$1 AND t.status<>'done' AND t.due_date<CURRENT_DATE
     ) SELECT c.event_key,c.type,c.id,c.room_id,c.room_name,c.title,c.occurred_at,
       to_char(c.due_date,'YYYY-MM-DD') AS due_date,c.priority
       FROM candidates c LEFT JOIN work_inbox_state s ON s.user_id=$1 AND s.event_key=c.event_key
       WHERE s.event_key IS NULL OR (s.state='snoozed' AND s.snoozed_until<=NOW())
       ORDER BY c.priority,c.occurred_at DESC,c.event_key LIMIT 101`, [userId]);
  return ok(res, { items: rows.rows.slice(0, 100), hasMore: rows.rowCount > 100 });
});

const setInboxState = asyncHandler(async (req, res) => {
  const eventKey = req.body?.eventKey;
  const state = req.body?.state;
  if (typeof eventKey !== "string" || !/^(?:(?:assignment|mention|blocked):[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|overdue:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d{4}-\d{2}-\d{2})$/i.test(eventKey))
    throw new ApiError(400, "Invalid inbox item");
  if (!["done", "snoozed", "open"].includes(state)) throw new ApiError(400, "Invalid inbox state");
  // Confirm current access before storing a personal action for the item.
  const [, type, id] = eventKey.match(/^(assignment|mention|blocked|overdue):([0-9a-f-]{36})/i) || [];
  const source = type === "mention"
    ? await query(`SELECT 1 FROM message_mentions mm JOIN messages m ON m.id=mm.message_id
       JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=$2
       WHERE m.id=$1 AND mm.user_id=$2 AND m.deleted_at IS NULL AND message_visible(m.id,$2)`, [id, req.user.id])
    : await query(`SELECT 1 FROM tasks t JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=$2
       WHERE t.id=$1 AND (t.assignee_id=$2 OR t.created_by=$2)`, [id, req.user.id]);
  if (!source.rowCount) throw new ApiError(404, "Inbox item unavailable");
  if (state === "open") await query("DELETE FROM work_inbox_state WHERE user_id=$1 AND event_key=$2",
    [req.user.id, eventKey]);
  else {
    const until = state === "snoozed" ? req.body?.until : null;
    if (state === "snoozed" && (!Number.isFinite(Date.parse(until)) ||
        Date.parse(until) <= Date.now() || Date.parse(until) > Date.now() + 30 * 86400000))
      throw new ApiError(400, "Snooze must end within 30 days");
    await query(`INSERT INTO work_inbox_state(user_id,event_key,state,snoozed_until)
      VALUES($1,$2,$3,$4) ON CONFLICT(user_id,event_key) DO UPDATE
      SET state=EXCLUDED.state,snoozed_until=EXCLUDED.snoozed_until,updated_at=NOW()`,
      [req.user.id, eventKey, state, until]);
  }
  return ok(res, { eventKey, state });
});

const listAutomations = asyncHandler(async (req, res) => {
  await project({ query }, req.params.projectId, req.user.id);
  const rules = await query(
    `SELECT a.*,COUNT(run.event_key)::int AS run_count,MAX(run.ran_at) AS last_run_at
     FROM project_automations a LEFT JOIN project_automation_runs run ON run.rule_id=a.id
     WHERE a.project_id=$1 GROUP BY a.id ORDER BY a.created_at DESC`, [req.params.projectId]);
  return ok(res, { rules: rules.rows });
});
const createAutomation = asyncHandler(async (req, res) => {
  await project({ query }, req.params.projectId, req.user.id, true);
  const trigger = req.body?.triggerKind;
  const action = trigger === "decision_recorded" ? "create_task" :
    trigger === "task_overdue" ? "notify_assignee" : null;
  if (!action) throw new ApiError(400, "Invalid automation trigger");
  const prefix = text(req.body?.titlePrefix || "Follow up:", 40, "Title prefix", true);
  const row = await query(
    `INSERT INTO project_automations(project_id,trigger_kind,action_kind,title_prefix,created_by)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.projectId, trigger, action, prefix, req.user.id]);
  return ok(res, row.rows[0], 201);
});
const setAutomation = asyncHandler(async (req, res) => {
  await project({ query }, req.params.projectId, req.user.id, true);
  if (typeof req.body?.enabled !== "boolean") throw new ApiError(400, "Invalid enabled state");
  const row = await query(
    "UPDATE project_automations SET enabled=$3 WHERE id=$1 AND project_id=$2 RETURNING *",
    [req.params.ruleId, req.params.projectId, req.body.enabled]);
  if (!row.rowCount) throw new ApiError(404, "Automation unavailable");
  return ok(res, row.rows[0]);
});

module.exports = { search, inbox, setInboxState,
  listAutomations, createAutomation, setAutomation };
