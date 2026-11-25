const bcrypt = require("bcrypt");
const { pool, query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { ok } = require("../utils/apiResponse");
const moderationRealtime = require("../services/moderationRealtime.service");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(["open", "reviewed", "upheld", "reversed"]);
const GENERIC = "If the account details are valid and eligible, the request has been recorded.";

async function verifyCredentials(body = {}) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = body.password;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== "string" || !password || Buffer.byteLength(password) > 72)
    return null;
  const user = (await query(
    `SELECT id,password_hash,suspension_case_id FROM users
     WHERE lower(email)=$1 AND deleted_at IS NULL`, [email],
  )).rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return null;
  return user;
}

const submitAppeal = asyncHandler(async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const reportId = req.body?.reportId || null;
  if (reason.length < 5 || reason.length > 3000) throw new ApiError(400, "Explain why you are appealing in 5–3,000 characters");
  if (reportId && !UUID.test(reportId)) throw new ApiError(400, "Invalid report reference");
  const user = await verifyCredentials(req.body);
  let createdAppealId = null;
  if (user) {
    let appealReportId = null;
    if (reportId) {
      const ownReport = await query(
        `SELECT id FROM user_reports WHERE id=$1 AND reported_user_id=$2 AND status='actioned'`,
        [reportId, user.id],
      );
      if (ownReport.rowCount) appealReportId = reportId;
    }
    const suspensionId = user.suspension_case_id || null;
    if (suspensionId || appealReportId) {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const created = await db.query(
          `INSERT INTO moderation_appeals(subject_user_id,suspension_case_id,report_id,reason)
           VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id,report_id`,
          [user.id, suspensionId, appealReportId, reason],
        );
        if (created.rowCount) {
          createdAppealId = created.rows[0].id;
          await db.query(
            `INSERT INTO moderation_audit(report_id,subject_user_id,action,reason,metadata)
             VALUES($1,$2,'appeal_submitted',$3,jsonb_build_object('appealId',$4))`,
            [appealReportId, user.id, reason, created.rows[0].id],
          );
        }
        await db.query("COMMIT");
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    }
  }
  if (createdAppealId) await moderationRealtime.emitToModerators(
    req.app.get("io"), "moderation:appeal-changed", { appealId: createdAppealId, action: "submitted" },
  );
  return ok(res, { accepted: true, message: GENERIC });
});

const appealStatus = asyncHandler(async (req, res) => {
  const user = await verifyCredentials(req.body);
  if (!user) return ok(res, { appeals: [], message: "No appeal could be found for these account details." });
  const [result, reports] = await Promise.all([query(
    `SELECT id,status,reason,resolution,created_at,updated_at
     FROM moderation_appeals WHERE subject_user_id=$1
     ORDER BY created_at DESC,id DESC LIMIT 20`, [user.id],
  ), query(
    `SELECT r.id,r.reason,r.created_at,room.name AS room_name
     FROM user_reports r LEFT JOIN rooms room ON room.id=r.room_id
     WHERE r.reported_user_id=$1 AND r.status='actioned'
       AND NOT EXISTS(SELECT 1 FROM moderation_appeals a WHERE a.subject_user_id=$1 AND a.report_id=r.id)
     ORDER BY r.created_at DESC LIMIT 20`, [user.id],
  )]);
  return ok(res, { appeals: result.rows, eligibleReports: reports.rows, canAppealSuspension: Boolean(user.suspension_case_id) });
});

const listAppeals = asyncHandler(async (req, res) => {
  const status = req.query.status || "open";
  if (status !== "all" && !STATUSES.has(status)) throw new ApiError(400, "Invalid appeal status");
  const assignment = req.query.assignment || "all";
  if (!["all", "mine", "unassigned"].includes(assignment)) throw new ApiError(400, "Invalid assignment filter");
  const values = [req.user.id];
  const filters = [];
  if (status !== "all") { values.push(status); filters.push(`a.status=$${values.length}`); }
  if (assignment === "mine") filters.push(`a.assigned_to=$1`);
  if (assignment === "unassigned") filters.push("a.assigned_to IS NULL");
  const rows = await query(
    `SELECT a.id,a.subject_user_id,a.suspension_case_id,a.report_id,a.reason,a.status,
       a.assigned_to,a.resolution,a.created_at,a.updated_at,
       subject.display_name AS subject_name,(subject.suspended_at IS NOT NULL) AS subject_suspended,
       assignee.display_name AS assignee_name,r.reason AS report_reason,r.status AS report_status
     FROM moderation_appeals a LEFT JOIN users subject ON subject.id=a.subject_user_id
     LEFT JOIN users assignee ON assignee.id=a.assigned_to LEFT JOIN user_reports r ON r.id=a.report_id
     ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
     ORDER BY (a.status='open') DESC,a.created_at ASC,a.id LIMIT 100`, values,
  );
  return ok(res, { appeals: rows.rows });
});

const getAppeal = asyncHandler(async (req, res) => {
  const appeal = (await query(
    `SELECT a.id,a.subject_user_id,a.suspension_case_id,a.report_id,a.reason,a.status,
       a.assigned_to,a.resolution,a.created_at,a.updated_at,
       subject.display_name AS subject_name,(subject.suspended_at IS NOT NULL) AS subject_suspended,
       assignee.display_name AS assignee_name,r.reason AS report_reason,r.status AS report_status
     FROM moderation_appeals a LEFT JOIN users subject ON subject.id=a.subject_user_id
     LEFT JOIN users assignee ON assignee.id=a.assigned_to LEFT JOIN user_reports r ON r.id=a.report_id
     WHERE a.id=$1`, [req.params.appealId],
  )).rows[0];
  if (!appeal) throw new ApiError(404, "Appeal unavailable");
  const audit = await query(
    `SELECT ma.id,ma.action,ma.from_status,ma.to_status,ma.reason,ma.metadata,
       ma.created_at,actor.display_name AS actor_name
     FROM moderation_audit ma LEFT JOIN users actor ON actor.id=ma.actor_user_id
     WHERE ma.metadata->>'appealId'=$1 OR ($2::uuid IS NOT NULL AND ma.report_id=$2)
     ORDER BY ma.created_at DESC,ma.id DESC LIMIT 50`, [appeal.id, appeal.report_id],
  );
  return ok(res, { appeal, audit: audit.rows });
});

async function activePlatformUser(db, userId) {
  if (!userId) return null;
  if (!UUID.test(userId)) throw new ApiError(400, "Invalid moderator");
  const moderator = (await db.query(
    `SELECT u.id,r.name FROM users u JOIN roles r ON r.id=u.role_id
     WHERE u.id=$1 AND u.deleted_at IS NULL AND u.suspended_at IS NULL`, [userId],
  )).rows[0];
  if (!moderator || !["moderator", "admin"].includes(moderator.name)) throw new ApiError(400, "Choose an active platform moderator");
  return moderator;
}

const listModerators = asyncHandler(async (req, res) => {
  const [result, viewer] = await Promise.all([query(
    `SELECT u.id,u.display_name,r.name AS role FROM users u JOIN roles r ON r.id=u.role_id
     WHERE u.deleted_at IS NULL AND u.suspended_at IS NULL AND r.name IN ('moderator','admin')
     ORDER BY r.name,u.display_name LIMIT 100`,
  ), query("SELECT r.name AS role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1", [req.user.id])]);
  return ok(res, { moderators: result.rows, canAssignOthers: viewer.rows[0]?.role === "admin" });
});

const assignAppeal = asyncHandler(async (req, res) => {
  const assignedTo = req.body?.assignedTo == null ? req.user.id : req.body.assignedTo;
  if (typeof assignedTo !== "string" || !UUID.test(assignedTo)) throw new ApiError(400, "Invalid moderator");
  const db = await pool.connect();
  let appeal;
  try {
    await db.query("BEGIN");
    await activePlatformUser(db, assignedTo);
    const current = (await db.query(
      `SELECT a.id,a.status,a.subject_user_id,a.suspension_case_id,a.report_id,a.assigned_to,
         u.suspended_by FROM moderation_appeals a LEFT JOIN users u ON u.id=a.subject_user_id
       WHERE a.id=$1 FOR UPDATE OF a`, [req.params.appealId],
    )).rows[0];
    if (!current) throw new ApiError(404, "Appeal unavailable");
    if (!["open", "reviewed"].includes(current.status)) throw new ApiError(409, "Resolved appeals cannot be reassigned");
    const actorRole = (await db.query("SELECT r.name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1", [req.user.id])).rows[0]?.name;
    if (assignedTo !== req.user.id && actorRole !== "admin") throw new ApiError(403, "Only a platform administrator can assign another reviewer");
    if (current.assigned_to && current.assigned_to !== req.user.id && actorRole !== "admin") throw new ApiError(409, "This appeal is assigned to another reviewer");
    const conflicting = await db.query(
      `SELECT 1 FROM moderation_audit ma WHERE ma.actor_user_id=$1 AND (
         (ma.action='account_suspended' AND ma.subject_user_id=$2 AND $3::uuid IS NOT NULL)
         OR (ma.action='report_transition' AND ma.report_id=$4 AND $4::uuid IS NOT NULL)
       ) LIMIT 1`, [assignedTo, current.subject_user_id, current.suspension_case_id, current.report_id],
    );
    if (conflicting.rowCount) throw new ApiError(409, "The moderator who made the original decision cannot review its appeal");
    appeal = (await db.query(
      "UPDATE moderation_appeals SET assigned_to=$2,updated_at=NOW() WHERE id=$1 RETURNING id,assigned_to,status",
      [current.id, assignedTo],
    )).rows[0];
    await db.query(
      `INSERT INTO moderation_audit(report_id,actor_user_id,subject_user_id,action,metadata)
       VALUES($1,$2,$3,'appeal_assigned',jsonb_build_object('appealId',$4,'assignedTo',$5))`,
      [current.report_id, req.user.id, current.subject_user_id, current.id, assignedTo],
    );
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
  moderationRealtime.emitToModerator(req.app.get("io"), assignedTo, "moderation:appeal-changed", { appealId: appeal.id, action: "assigned" });
  return ok(res, appeal);
});

const transitionAppeal = asyncHandler(async (req, res) => {
  const nextStatus = req.body?.status;
  const expectedStatus = req.body?.expectedStatus;
  if (!STATUSES.has(nextStatus) || !STATUSES.has(expectedStatus) || nextStatus === expectedStatus) throw new ApiError(400, "Choose a valid appeal transition");
  const reason = typeof req.body?.resolution === "string" ? req.body.resolution.trim() : "";
  if (reason.length < 5 || reason.length > 1000) throw new ApiError(400, "Decision must be 5–1,000 characters");
  const allowed = { open: ["reviewed", "upheld", "reversed"], reviewed: ["open", "upheld", "reversed"] };
  if (!allowed[expectedStatus]?.includes(nextStatus)) throw new ApiError(409, "This appeal is already resolved");
  const db = await pool.connect();
  let result;
  try {
    await db.query("BEGIN");
    const appeal = (await db.query(
      `SELECT a.*,u.suspension_case_id AS current_suspension,u.suspended_by
       FROM moderation_appeals a LEFT JOIN users u ON u.id=a.subject_user_id
       WHERE a.id=$1 FOR UPDATE OF a`, [req.params.appealId],
    )).rows[0];
    if (!appeal) throw new ApiError(404, "Appeal unavailable");
    if (appeal.status !== expectedStatus) throw new ApiError(409, "This appeal changed. Reload before deciding.");
    if (appeal.assigned_to !== req.user.id) throw new ApiError(403, "Claim this appeal before reviewing it");
    if (appeal.suspended_by === req.user.id && appeal.suspension_case_id) throw new ApiError(409, "The moderator who made the original decision cannot review its appeal");
    if (appeal.report_id && (await db.query(
      `SELECT 1 FROM moderation_audit WHERE report_id=$1 AND actor_user_id=$2 AND action='report_transition' LIMIT 1`,
      [appeal.report_id, req.user.id],
    )).rowCount) throw new ApiError(409, "The moderator who made the original decision cannot review its appeal");
    if (nextStatus === "reversed" && appeal.suspension_case_id && appeal.current_suspension === appeal.suspension_case_id) {
      await db.query(
        `UPDATE users SET suspended_at=NULL,suspended_by=NULL,suspension_reason=NULL,suspension_case_id=NULL
         WHERE id=$1`, [appeal.subject_user_id],
      );
      await db.query(
        `INSERT INTO moderation_audit(actor_user_id,subject_user_id,action,reason,metadata)
         VALUES($1,$2,'account_restored',$3,jsonb_build_object('appealId',$4))`,
        [req.user.id, appeal.subject_user_id, reason, appeal.id],
      );
    }
    if (nextStatus === "reversed" && appeal.report_id) {
      const report = await db.query(
        "UPDATE user_reports SET status='reviewed' WHERE id=$1 AND status='actioned' RETURNING id",
        [appeal.report_id],
      );
      if (report.rowCount) await db.query(
        `INSERT INTO moderation_audit(report_id,actor_user_id,subject_user_id,action,from_status,to_status,reason)
         VALUES($1,$2,$3,'report_transition','actioned','reviewed',$4)`,
        [appeal.report_id, req.user.id, appeal.subject_user_id, `Appeal reversed: ${reason}`.slice(0, 1000)],
      );
    }
    result = (await db.query(
      `UPDATE moderation_appeals SET status=$2,resolution=$3,reviewed_by=$4,updated_at=NOW()
       WHERE id=$1 RETURNING id,status,assigned_to`,
      [appeal.id, nextStatus, reason, req.user.id],
    )).rows[0];
    await db.query(
      `INSERT INTO moderation_audit(report_id,actor_user_id,subject_user_id,action,from_status,to_status,reason,metadata)
       VALUES($1,$2,$3,'appeal_transition',$4,$5,$6,jsonb_build_object('appealId',$7))`,
      [appeal.report_id, req.user.id, appeal.subject_user_id, appeal.status, nextStatus, reason, appeal.id],
    );
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
  await moderationRealtime.emitToModerators(req.app.get("io"), "moderation:appeal-changed", { appealId: result.id, action: "updated" });
  return ok(res, result);
});

module.exports = { submitAppeal, appealStatus, listAppeals, getAppeal, listModerators, assignAppeal, transitionAppeal };
