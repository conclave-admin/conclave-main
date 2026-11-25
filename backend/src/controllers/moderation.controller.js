const { pool, query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { ok } = require("../utils/apiResponse");
const { revokeSessionAccess } = require("../services/realtimeAccess.service");
const { getStorageOverview: readStorageOverview } = require("../services/storageMonitor.service");

const STATUSES = new Set(["open", "reviewed", "actioned", "dismissed"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function boundedText(value, label, min, max) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max)
    throw new ApiError(400, `${label} must be ${min}–${max} characters`);
  return value.trim();
}

const listReports = asyncHandler(async (req, res) => {
  const status = req.query.status || "open";
  if (status !== "all" && !STATUSES.has(status)) throw new ApiError(400, "Invalid report status");
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit || "25", 10) || 25));
  const assignment = req.query.assignment || "all";
  if (!["all", "mine", "unassigned"].includes(assignment)) throw new ApiError(400, "Invalid assignment filter");
  let before = null;
  if (req.query.before) {
    try { before = JSON.parse(Buffer.from(req.query.before, "base64url").toString("utf8")); }
    catch { throw new ApiError(400, "Invalid report cursor"); }
    if (!UUID.test(before?.id || "") || !Number.isFinite(Date.parse(before?.createdAt || "")))
      throw new ApiError(400, "Invalid report cursor");
  }
  const values = [limit + 1, req.user.id];
  const where = [];
  if (status !== "all") { values.push(status); where.push(`ur.status=$${values.length}`); }
  if (before) {
    values.push(before.createdAt, before.id);
    where.push(`(ur.created_at,ur.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`);
  }
  if (assignment === "mine") where.push("ur.assigned_to=$2");
  if (assignment === "unassigned") where.push("ur.assigned_to IS NULL");
  const result = await query(
    `SELECT ur.id,ur.reported_user_id,ur.room_id,ur.reason,ur.details,ur.status,ur.assigned_to,
       ur.created_at,reported.display_name AS reported_display_name,
       (reported.suspended_at IS NOT NULL) AS reported_suspended,
       r.name AS room_name,assignee.display_name AS assignee_name
     FROM user_reports ur JOIN users reported ON reported.id=ur.reported_user_id
     LEFT JOIN users assignee ON assignee.id=ur.assigned_to
     LEFT JOIN rooms r ON r.id=ur.room_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ur.created_at DESC,ur.id DESC LIMIT $1`, values);
  const items = result.rows.slice(0, limit);
  const last = items.at(-1);
  return ok(res, {
    reports: items,
    nextCursor: result.rowCount > limit && last
      ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString("base64url")
      : null,
  });
});

const getReport = asyncHandler(async (req, res) => {
  const db = await pool.connect();
  let report;
  let audit;
  try {
    await db.query("BEGIN");
    report = (await db.query(
      `SELECT ur.id,ur.reported_user_id,ur.room_id,ur.reason,ur.details,ur.status,ur.assigned_to,ur.created_at,
         reported.display_name AS reported_display_name,
         (reported.suspended_at IS NOT NULL) AS reported_suspended,
         reported.suspension_reason,r.name AS room_name,assignee.display_name AS assignee_name
       FROM user_reports ur JOIN users reported ON reported.id=ur.reported_user_id
       LEFT JOIN users assignee ON assignee.id=ur.assigned_to
       LEFT JOIN rooms r ON r.id=ur.room_id WHERE ur.id=$1`, [req.params.reportId])).rows[0];
    if (!report) throw new ApiError(404, "Report unavailable");
    await db.query(
      `INSERT INTO moderation_audit(report_id,actor_user_id,subject_user_id,action)
       VALUES($1,$2,$3,'report_viewed')`, [report.id, req.user.id, report.reported_user_id]);
    audit = await db.query(
      `SELECT ma.id,ma.action,ma.actor_user_id,actor.display_name AS actor_name,
         ma.from_status,ma.to_status,ma.reason,ma.metadata,ma.created_at
       FROM moderation_audit ma LEFT JOIN users actor ON actor.id=ma.actor_user_id
       WHERE ma.report_id=$1 ORDER BY ma.created_at DESC,ma.id DESC LIMIT 50`, [report.id]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { db.release(); }

  const context = report.room_id ? await query(
    `SELECT m.id,u.display_name AS sender_name,LEFT(m.content,500) AS content,m.created_at
     FROM messages m LEFT JOIN users u ON u.id=m.sender_id
     WHERE m.room_id=$1 AND m.deleted_at IS NULL
       AND m.created_at BETWEEN $2::timestamptz-INTERVAL '10 minutes' AND $2::timestamptz+INTERVAL '10 minutes'
     ORDER BY abs(extract(epoch FROM (m.created_at-$2::timestamptz))),m.id LIMIT 3`,
    [report.room_id, report.created_at]) : { rows: [] };
  return ok(res, { report, context: context.rows, audit: audit.rows });
});

const transitionReport = asyncHandler(async (req, res) => {
  const nextStatus = req.body?.status;
  const expectedStatus = req.body?.expectedStatus;
  if (!STATUSES.has(nextStatus) || !STATUSES.has(expectedStatus))
    throw new ApiError(400, "Choose a valid report status and current status");
  if (nextStatus === expectedStatus) throw new ApiError(400, "Choose a different report status");
  const reason = boundedText(req.body?.reason, "Decision reason", 5, 1000);
  const db = await pool.connect();
  let updated;
  try {
    await db.query("BEGIN");
    const current = (await db.query("SELECT id,reported_user_id,status,assigned_to FROM user_reports WHERE id=$1 FOR UPDATE", [req.params.reportId])).rows[0];
    if (!current) throw new ApiError(404, "Report unavailable");
    const actorRole = (await db.query("SELECT r.name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1", [req.user.id])).rows[0]?.name;
    if (current.assigned_to !== req.user.id && actorRole !== "admin") throw new ApiError(403, "Claim this report before recording a decision");
    if (current.status !== expectedStatus)
      throw new ApiError(409, "This report changed. Reload it before deciding.");
    updated = (await db.query(
      "UPDATE user_reports SET status=$2 WHERE id=$1 RETURNING id,status,reported_user_id",
      [current.id, nextStatus])).rows[0];
    await db.query(
      `INSERT INTO moderation_audit(report_id,actor_user_id,subject_user_id,action,from_status,to_status,reason)
       VALUES($1,$2,$3,'report_transition',$4,$5,$6)`,
      [current.id, req.user.id, current.reported_user_id, current.status, nextStatus, reason]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { db.release(); }
  return ok(res, { reportId: updated.id, status: updated.status });
});

async function setSuspension(req, res, suspended) {
  const reason = boundedText(req.body?.reason, "Reason", 5, 1000);
  const reportId = req.body?.reportId;
  if (!reportId || !UUID.test(reportId)) throw new ApiError(400, "A report reference is required");
  const db = await pool.connect();
  let sessions = [];
  let changed;
  try {
    await db.query("BEGIN");
    const caseReport = (await db.query(
      "SELECT reported_user_id,assigned_to FROM user_reports WHERE id=$1 FOR UPDATE",
      [reportId],
    )).rows[0];
    if (!caseReport || caseReport.reported_user_id !== req.params.userId) throw new ApiError(404, "Report unavailable");
    const actorRole = (await db.query("SELECT r.name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1", [req.user.id])).rows[0]?.name;
    if (caseReport.assigned_to !== req.user.id && actorRole !== "admin") throw new ApiError(403, "Claim this report before changing the account status");
    const target = (await db.query(
      "SELECT id,suspended_at FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
      [req.params.userId])).rows[0];
    if (!target) throw new ApiError(404, "Account unavailable");
    if (target.id === req.user.id) throw new ApiError(409, "Moderators cannot change their own account status");
    if (Boolean(target.suspended_at) === suspended) {
      await db.query("COMMIT");
      return ok(res, { userId: target.id, suspended, changed: false });
    }
    if (suspended) {
      sessions = (await db.query(
        `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW())
         WHERE user_id=$1 AND revoked_at IS NULL RETURNING id`, [target.id])).rows;
      await db.query("UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1", [target.id]);
      await db.query(
        "UPDATE users SET suspended_at=NOW(),suspended_by=$2,suspension_reason=$3,suspension_case_id=gen_random_uuid() WHERE id=$1",
        [target.id, req.user.id, reason]);
    } else {
      await db.query("UPDATE users SET suspended_at=NULL,suspended_by=NULL,suspension_reason=NULL,suspension_case_id=NULL WHERE id=$1", [target.id]);
    }
    await db.query(
      `INSERT INTO moderation_audit(report_id,actor_user_id,subject_user_id,action,reason)
       VALUES($1,$2,$3,$4,$5)`,
      [reportId, req.user.id, target.id, suspended ? "account_suspended" : "account_restored", reason]);
    await db.query("COMMIT");
    changed = true;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { db.release(); }
  if (suspended) {
    const io = req.app.get("io");
    const results = await Promise.allSettled(sessions.map((session) => revokeSessionAccess(io, session.id)));
    if (results.some((result) => result.status === "rejected"))
      throw new ApiError(503, "Account suspension is saved, but realtime session removal could not be confirmed. Retry the action.");
  }
  return ok(res, { userId: req.params.userId, suspended, changed });
}

const suspendAccount = asyncHandler((req, res) => setSuspension(req, res, true));
const restoreAccount = asyncHandler((req, res) => setSuspension(req, res, false));

const assignReport = asyncHandler(async (req, res) => {
  const assignedTo = req.body?.assignedTo === undefined ? req.user.id : req.body.assignedTo;
  if (assignedTo !== null && (typeof assignedTo !== "string" || !UUID.test(assignedTo))) throw new ApiError(400, "Invalid moderator");
  const db = await pool.connect();
  let report;
  try {
    await db.query("BEGIN");
    if (assignedTo) {
      const moderator = (await db.query(
        `SELECT r.name FROM users u JOIN roles r ON r.id=u.role_id
         WHERE u.id=$1 AND u.deleted_at IS NULL AND u.suspended_at IS NULL`, [assignedTo],
      )).rows[0];
      if (!moderator || !["moderator", "admin"].includes(moderator.name)) throw new ApiError(400, "Choose an active platform moderator");
    }
    const current = (await db.query("SELECT id,reported_user_id,assigned_to FROM user_reports WHERE id=$1 FOR UPDATE", [req.params.reportId])).rows[0];
    if (!current) throw new ApiError(404, "Report unavailable");
    const actorRole = (await db.query("SELECT r.name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1", [req.user.id])).rows[0]?.name;
    if (assignedTo && assignedTo !== req.user.id && actorRole !== "admin") throw new ApiError(403, "Only a platform administrator can assign another reviewer");
    if (current.assigned_to && current.assigned_to !== req.user.id && actorRole !== "admin") throw new ApiError(409, "This report is assigned to another reviewer");
    report = (await db.query("UPDATE user_reports SET assigned_to=$2 WHERE id=$1 RETURNING id,assigned_to", [current.id, assignedTo])).rows[0];
    await db.query(
      `INSERT INTO moderation_audit(report_id,actor_user_id,subject_user_id,action,metadata)
       VALUES($1,$2,$3,'report_assigned',jsonb_build_object('from',$4,'to',$5))`,
      [current.id, req.user.id, current.reported_user_id, current.assigned_to, assignedTo],
    );
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
  finally { db.release(); }
  return ok(res, report);
});

const getStorageOverview = asyncHandler(async (_req, res) => {
  return ok(res, await readStorageOverview());
});

module.exports = { listReports, getReport, transitionReport, suspendAccount, restoreAccount, assignReport, getStorageOverview };
