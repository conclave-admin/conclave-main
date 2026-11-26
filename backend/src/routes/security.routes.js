const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const wrap = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const limit = require("../middlewares/rateLimit.middleware");
const security = require("../services/accountSecurity.service");
const privacy = require("../services/privacy.service");
const { query, pool } = require("../config/db");
const ApiError = require("../utils/ApiError");
const { UUID } = require("../utils/mediaPagination");
const emailLimit = limit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  key: (req) => [
    req.ip,
    String(req.body?.email || "")
      .trim()
      .toLowerCase(),
  ],
});
router.post(
  "/recovery",
  emailLimit,
  wrap(async (req, res) =>
    ok(res, await security.requestToken(req.body?.email, "reset_password")),
  ),
);
router.post(
  "/reset",
  limit({ max: 10 }),
  wrap(async (req, res) =>
    ok(
      res,
      await security.redeem(
        req.body?.token,
        "reset_password",
        req.body?.password,
        req.app.get("io"),
      ),
    ),
  ),
);
router.post(
  "/verify",
  limit({ max: 15 }),
  wrap(async (req, res) =>
    ok(
      res,
      await security.redeem(
        req.body?.token,
        "verify_email",
        null,
        req.app.get("io"),
      ),
    ),
  ),
);
router.use(auth);
router.get(
  "/privacy",
  wrap(async (req, res) => ok(res, await privacy.get(req.user.id))),
);
router.patch(
  "/privacy",
  limit({ max: 20 }),
  wrap(async (req, res) =>
    ok(res, await privacy.update(req.user.id, req.body, req.app.get("io"))),
  ),
);
router.post(
  "/verification",
  limit({ windowMs: 60 * 60 * 1000, max: 5 }),
  wrap(async (req, res) => {
    const user = (
      await query("SELECT email FROM users WHERE id=$1", [req.user.id])
    ).rows[0];
    return ok(
      res,
      await security.requestToken(user.email, "verify_email", {
        userId: req.user.id,
      }),
    );
  }),
);
router.post(
  "/verification/code",
  wrap(async (req, res) =>
    ok(res, await security.redeemVerificationCode(req.user.id, req.body?.code)),
  ),
);
router.get(
  "/sessions",
  wrap(async (req, res) =>
    ok(res, {
      sessions: await security.listSessions(req.user.id, req.user.sessionId),
    }),
  ),
);
router.delete(
  "/sessions/:sessionId",
  limit({ max: 10 }),
  wrap(async (req, res) => {
    if (req.params.sessionId !== "others" && !UUID.test(req.params.sessionId))
      throw new ApiError(400, "Invalid session");
    return ok(
      res,
      await security.revoke(
        req.user.id,
        req.user.sessionId,
        req.params.sessionId,
        req.body?.password,
        req.app.get("io"),
      ),
    );
  }),
);
router.patch(
  "/session",
  wrap(async (req, res) => {
    const label = req.body?.label;
    if (typeof label !== "string" || !label.trim() || label.length > 80)
      throw new ApiError(400, "Use a device name of 1–80 characters");
    await query(
      "UPDATE auth_sessions SET device_label=$3 WHERE user_id=$1 AND id=$2",
      [req.user.id, req.user.sessionId, label.trim()],
    );
    return ok(res, { label: label.trim() });
  }),
);
router.get(
  "/requests",
  wrap(async (req, res) =>
    ok(res, {
      requests: (
        await query(
          `SELECT d.*,u.display_name AS sender_name,u.avatar_url AS sender_avatar
             FROM dm_requests d JOIN users u ON u.id=d.sender_id
            WHERE d.recipient_id=$1 AND d.status IN ('pending','declined')
              AND u.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM user_blocks b
                 WHERE (b.blocker_id=d.recipient_id AND b.blocked_id=d.sender_id)
                    OR (b.blocker_id=d.sender_id AND b.blocked_id=d.recipient_id)
              )
            ORDER BY (d.status='pending') DESC, d.updated_at DESC LIMIT 100`,
          [req.user.id],
        )
      ).rows,
    }),
  ),
);
router.post(
  "/requests/:roomId",
  wrap(async (req, res) => {
    if (
      !UUID.test(req.params.roomId) ||
      !["accepted", "declined", "undo_decline"].includes(req.body?.status)
    ) throw new ApiError(400, "Choose accept, decline, or undo decline");
    const db = await pool.connect();
    let row;
    try {
      await db.query("BEGIN");
      await db.query("SELECT id FROM rooms WHERE id=$1 FOR UPDATE", [
        req.params.roomId,
      ]);
      const request = (await db.query(
        "SELECT * FROM dm_requests WHERE room_id=$1 AND recipient_id=$2 FOR UPDATE",
        [req.params.roomId, req.user.id],
      )).rows[0];
      if (!request) throw new ApiError(404, "Message request not found");

      await db.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(
          LEAST($1::text,$2::text)||':'||GREATEST($1::text,$2::text),51))`,
        [request.recipient_id, request.sender_id],
      );

      const blocked = await db.query(
        `SELECT 1 FROM user_blocks
          WHERE (blocker_id=$1 AND blocked_id=$2)
             OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`,
        [request.recipient_id, request.sender_id],
      );
      if (blocked.rowCount && req.body.status !== "declined")
        throw new ApiError(403, "Unblock this person before accepting the request");

      if (req.body.status === "declined") {
        if (request.status !== "pending")
          throw new ApiError(409, "This message request is no longer pending");
        row = (await db.query(
          `UPDATE dm_requests SET status='declined',declined_at=NOW(),updated_at=NOW()
            WHERE room_id=$1 RETURNING *`,
          [req.params.roomId],
        )).rows[0];
      } else if (req.body.status === "undo_decline") {
        if (request.status !== "declined")
          throw new ApiError(409, "There is no decline to undo");
        row = (await db.query(
          `UPDATE dm_requests SET status='pending',declined_at=NULL,updated_at=NOW()
            WHERE room_id=$1 AND declined_at >= NOW()-INTERVAL '10 seconds'
            RETURNING *`,
          [req.params.roomId],
        )).rows[0];
        if (!row) throw new ApiError(409, "The undo period has ended");
      } else {
        if (!["pending", "declined"].includes(request.status))
          throw new ApiError(409, "This message request is no longer available");
        row = (await db.query(
          `UPDATE dm_requests SET status='accepted',declined_at=NULL,updated_at=NOW()
            WHERE room_id=$1 RETURNING *`,
          [req.params.roomId],
        )).rows[0];
      }
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
    return ok(res, row);
  }),
);
module.exports = router;
