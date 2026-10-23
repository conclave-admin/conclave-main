const router = require("express").Router();
const auth = require("../middlewares/auth.middleware"),
  wrap = require("../utils/asyncHandler"),
  { ok } = require("../utils/apiResponse");
const limit = require("../middlewares/rateLimit.middleware"),
  service = require("../services/roomLifecycle.service");
const { UUID } = require("../utils/mediaPagination"),
  ApiError = require("../utils/ApiError"),
  { query } = require("../config/db");
for (const key of ["roomId", "userId", "inviteId"])
  router.param(key, (_req, _res, next, value) =>
    next(UUID.test(value) ? undefined : new ApiError(400, `Invalid ${key}`)),
  );
router.get(
  "/:roomId/management",
  auth,
  wrap(async (req, res) =>
    ok(res, await service.state(req.params.roomId, req.user.id)),
  ),
);
router.patch(
  "/:roomId/settings",
  auth,
  limit({ max: 20 }),
  wrap(async (req, res) =>
    ok(res, await service.settings(req.params.roomId, req.user.id, req.body)),
  ),
);
router.post(
  "/:roomId/invitations",
  auth,
  limit({ max: 15 }),
  wrap(async (req, res) =>
    ok(
      res,
      await service.invite(req.params.roomId, req.user.id, req.body),
      201,
    ),
  ),
);
router.delete(
  "/:roomId/invitations/:inviteId",
  auth,
  limit({ max: 20 }),
  wrap(async (req, res) =>
    ok(
      res,
      await service.revoke(req.params.roomId, req.user.id, req.params.inviteId),
    ),
  ),
);
router.post(
  "/invitations/status",
  auth,
  limit({ max: 60 }),
  wrap(async (req, res) =>
    ok(res, await service.invitationStatus(req.user.id, req.body?.token)),
  ),
);
router.post(
  "/invitations/accept",
  auth,
  limit({ max: 20 }),
  wrap(async (req, res) =>
    ok(
      res,
      await service.enter({ token: req.body?.token, userId: req.user.id }),
    ),
  ),
);
router.post(
  "/:roomId/requests/:userId",
  auth,
  limit({ max: 30 }),
  wrap(async (req, res) =>
    ok(
      res,
      await service.review(
        req.params.roomId,
        req.user.id,
        req.params.userId,
        req.body?.decision,
      ),
    ),
  ),
);
router.post(
  "/:roomId/handover",
  auth,
  limit({ max: 10 }),
  wrap(async (req, res) => {
    if (!UUID.test(req.body?.successorId || ""))
      throw new ApiError(400, "Choose a participant");
    return ok(
      res,
      await service.handover(
        req.params.roomId,
        req.user.id,
        req.body.successorId,
      ),
    );
  }),
);
router.post(
  "/:roomId/clear",
  auth,
  limit({ max: 10 }),
  wrap(async (req, res) =>
    ok(res, await service.clear(req.params.roomId, req.user.id)),
  ),
);
router.get(
  "/:roomId/links",
  auth,
  wrap(async (req, res) => {
    const room = (
      await query(
        "SELECT r.encryption_mode FROM rooms r JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$2 WHERE r.id=$1",
        [req.params.roomId, req.user.id],
      )
    ).rows[0];
    if (!room) throw new ApiError(404, "Conversation not found");
    if (room.encryption_mode === "e2ee-v1")
      throw new ApiError(409, "Browse encrypted links on this device");
    const before = req.query.before;
    if (
      before !== undefined &&
      (typeof before !== "string" ||
        !/^\d{1,19}$/.test(before) ||
        BigInt(before) > 9223372036854775807n)
    )
      throw new ApiError(400, "Invalid links cursor");
    const rows = (
      await query(
        `SELECT id,room_id,room_sequence,content,created_at FROM messages WHERE room_id=$1 AND deleted_at IS NULL AND message_visible(id,$2) AND content ~* 'https?://' AND ($3::bigint IS NULL OR room_sequence<$3::bigint) ORDER BY room_sequence DESC LIMIT 26`,
        [req.params.roomId, req.user.id, before || null],
      )
    ).rows;
    return ok(res, {
      messages: rows.slice(0, 25),
      nextCursor: rows.length > 25 ? rows[24].room_sequence : null,
    });
  }),
);
module.exports = router;
