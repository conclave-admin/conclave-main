const { pool, query } = require("../config/db");
const { createNotification, presentNotification, emitNotification, personalRoom } = require("./notification.service");

let timer = null;
let running = null;

async function run(io) {
  const candidates = await query(
    `SELECT a.id AS rule_id,a.trigger_kind,a.title_prefix,a.created_by,
       d.id AS decision_id,d.room_id,d.title AS decision_title,NULL::uuid AS task_id,
       NULL::uuid AS assignee_id,NULL::date AS due_date,
       ('decision:'||d.id::text) AS event_key
     FROM project_automations a JOIN project_rooms pr ON pr.project_id=a.project_id
     JOIN decisions d ON d.room_id=pr.room_id AND d.created_at>=a.created_at
     JOIN room_members rm ON rm.room_id=d.room_id AND rm.user_id=a.created_by
     WHERE a.enabled AND a.trigger_kind='decision_recorded' AND d.status='active'
       AND NOT EXISTS(SELECT 1 FROM project_automation_runs run
         WHERE run.rule_id=a.id AND run.event_key='decision:'||d.id::text)
     UNION ALL
     SELECT a.id,a.trigger_kind,a.title_prefix,a.created_by,
       NULL::uuid,NULL::uuid,NULL::text,t.id,t.assignee_id,t.due_date,
       ('overdue:'||t.id::text||':'||t.due_date::text)
     FROM project_automations a JOIN tasks t ON t.project_id=a.project_id
     JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=t.assignee_id
     WHERE a.enabled AND a.trigger_kind='task_overdue' AND t.status<>'done'
       AND t.assignee_id IS NOT NULL AND t.due_date<CURRENT_DATE
       AND t.updated_at>=a.created_at
       AND NOT EXISTS(SELECT 1 FROM project_automation_runs run
         WHERE run.rule_id=a.id AND run.event_key='overdue:'||t.id::text||':'||t.due_date::text)
     LIMIT 50`);
  for (const item of candidates.rows) {
    const db = await pool.connect();
    let notification = null;
    try {
      await db.query("BEGIN");
      const claimed = await db.query(
        `INSERT INTO project_automation_runs(rule_id,event_key)
         VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_key`,
        [item.rule_id, item.event_key]);
      if (!claimed.rowCount) { await db.query("COMMIT"); continue; }
      if (item.trigger_kind === "decision_recorded") {
        const rule = await db.query(
          `SELECT a.project_id FROM project_automations a
           JOIN project_rooms pr ON pr.project_id=a.project_id AND pr.room_id=$2
           JOIN room_members rm ON rm.room_id=pr.room_id AND rm.user_id=a.created_by
           WHERE a.id=$1 AND a.enabled`, [item.rule_id, item.room_id]);
        if (!rule.rowCount) { await db.query("ROLLBACK"); continue; }
        const title = `${item.title_prefix} ${item.decision_title}`.slice(0, 160);
        const task = await db.query(
          `INSERT INTO tasks(room_id,title,initial_title,created_by,decision_id,project_id)
           VALUES($1,$2,$2,$3,$4,$5) RETURNING id`,
          [item.room_id, title, item.created_by, item.decision_id, rule.rows[0].project_id]);
        await db.query("UPDATE project_automation_runs SET result_id=$3 WHERE rule_id=$1 AND event_key=$2",
          [item.rule_id, item.event_key, task.rows[0].id]);
      } else {
        const valid = await db.query(
          `SELECT 1 FROM tasks t JOIN project_automations a ON a.project_id=t.project_id
           JOIN room_members rm ON rm.room_id=t.room_id AND rm.user_id=t.assignee_id
           WHERE t.id=$1 AND a.id=$2 AND a.enabled AND t.status<>'done'
             AND t.assignee_id=$3 AND t.due_date=$4`,
          [item.task_id, item.rule_id, item.assignee_id, item.due_date]);
        if (!valid.rowCount) { await db.query("ROLLBACK"); continue; }
        notification = await createNotification({ recipientId: item.assignee_id,
          type: "task", referenceId: item.task_id,
          dedupeKey: `${item.assignee_id}:project-rule:${item.rule_id}:${item.event_key}`, db });
        await db.query("UPDATE project_automation_runs SET result_id=$3 WHERE rule_id=$1 AND event_key=$2",
          [item.rule_id, item.event_key, notification.id]);
      }
      await db.query("COMMIT");
      if (notification) await emitNotification(io, item.assignee_id, await presentNotification(notification));
      else if (io) {
        const members = await query("SELECT user_id FROM room_members WHERE room_id=$1", [item.room_id]);
        for (const member of members.rows)
          io.to(personalRoom(member.user_id)).emit("task:updated", { roomId: item.room_id });
      }
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      console.error("Project automation failed", { ruleId: item.rule_id, code: error.code || error.name });
    } finally { db.release(); }
  }
}
function start(io) {
  if (timer) return;
  const tick = () => {
    if (running) return;
    running = run(io).catch((error) =>
      console.error("Project automation scan failed", { code: error.code || error.name }))
      .finally(() => { running = null; });
  };
  timer = setInterval(tick, 60000);
  timer.unref?.();
  tick();
}
async function stop() { clearInterval(timer); timer = null; await running; }
module.exports = { run, start, stop };
