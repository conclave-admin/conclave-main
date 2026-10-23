const router = require("express").Router();
const wrap = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { query } = require("../config/db");
const service = require("../services/encryption.service");
const { UUID } = require("../utils/mediaPagination");
const ApiError = require("../utils/ApiError");
router.use(require("../middlewares/auth.middleware"));
router.use(require("../middlewares/rateLimit.middleware")({ max: 60 }));
router.post(
  "/reset",
  require("../middlewares/rateLimit.middleware")({ max: 5 }),
  wrap(async (req, res) =>
    ok(
      res,
      await service.reset(
        req.user.id,
        req.user.sessionId,
        req.body,
        req.app.get("io"),
      ),
    ),
  ),
);
router.get(
  "/devices",
  wrap(async (req, res) => ok(res, await service.state(req.user.id))),
);
router.post(
  "/devices",
  wrap(async (req, res) =>
    ok(
      res,
      await service.register(req.user.id, req.user.sessionId, req.body),
      201,
    ),
  ),
);
router.post(
  "/devices/:id/approve",
  wrap(async (req, res) =>
    ok(res, await service.approve(req.user.id, req.params.id, req.body)),
  ),
);
router.get(
  "/devices/:id/link",
  wrap(async (req, res) =>
    ok(
      res,
      await service.takeLink(req.user.id, req.user.sessionId, req.params.id),
    ),
  ),
);
router.delete(
  "/devices/:id",
  wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) throw new ApiError(400, "Invalid device");
    const device = (
      await query(
        "SELECT session_id FROM encryption_devices WHERE id=$1 AND user_id=$2",
        [req.params.id, req.user.id],
      )
    ).rows[0];
    if (!device) throw new ApiError(404, "Encryption device not found");
    return ok(
      res,
      await require("../services/accountSecurity.service").revoke(
        req.user.id,
        req.user.sessionId,
        device.session_id,
        req.body?.password,
        req.app.get("io"),
      ),
    );
  }),
);
router.get(
  "/rooms/:id",
  wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) throw new ApiError(400, "Invalid room");
    return ok(
      res,
      await service.roomDevices({ query }, req.params.id, req.user.id),
    );
  }),
);
router.post(
  "/rooms/:id/upgrade",
  wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) throw new ApiError(400, "Invalid room");
    const { pool } = require("../config/db"),
      crypto = require("node:crypto"),
      db = await pool.connect();
    let target;
    try {
      await db.query("BEGIN");
      const room = (
        await db.query(
          `SELECT r.*,rm.role FROM rooms r JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$2 WHERE r.id=$1 FOR UPDATE OF r`,
          [req.params.id, req.user.id],
        )
      ).rows[0];
      if (!room) throw new ApiError(404, "Conversation not found");
      if (
        room.type === "public" ||
        (room.type !== "dm" && room.role !== "admin")
      )
        throw new ApiError(
          403,
          "Only an admin can move a private room to encryption",
        );
      if (room.encryption_mode !== "none")
        throw new ApiError(409, "This conversation is already encrypted");
      target = room.superseded_by;
      if (!target) {
        const roster = await service.roomDevices(db, room.id, req.user.id);
        if (
          roster.members.some(
            (u) => !roster.devices.some((d) => d.user_id === u.id),
          )
        )
          throw new ApiError(
            409,
            "Each participant needs an approved encryption device first",
          );
        const id = crypto.randomUUID();
        target = id;
        await db.query(
          "INSERT INTO rooms(id,name,type,created_by,slug,encryption_mode) VALUES($1,$2,$3,$4,$5,'e2ee-v1')",
          [
            id,
            room.name,
            room.type === "dm" ? "dm" : "private",
            req.user.id,
            `encrypted-${id}`,
          ],
        );
        await db.query(
          "INSERT INTO room_members(room_id,user_id,role) SELECT $2,user_id,role FROM room_members WHERE room_id=$1",
          [room.id, id],
        );
        await db.query("UPDATE rooms SET superseded_by=$2 WHERE id=$1", [
          room.id,
          id,
        ]);
      }
      await db.query("COMMIT");
      return ok(res, { roomId: target });
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }),
);
router.get(
  "/backup",
  wrap(async (req, res) => {
    const row = (
      await query(
        "SELECT payload,revision,updated_at FROM encryption_backups WHERE user_id=$1",
        [req.user.id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "No encrypted backup is available");
    return ok(res, row);
  }),
);
router.put(
  "/backup",
  wrap(async (req, res) =>
    ok(res, await service.backup(req.user.id, req.body)),
  ),
);
router.delete(
  "/backup",
  wrap(async (req, res) => {
    await require("../services/accountSecurity.service").confirm(
      req.user.id,
      req.body?.password,
    );
    await query("DELETE FROM encryption_backups WHERE user_id=$1", [
      req.user.id,
    ]);
    return ok(res, { deleted: true });
  }),
);
module.exports = router;
