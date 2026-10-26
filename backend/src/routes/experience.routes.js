const router = require("express").Router();
const auth = require("../middlewares/auth.middleware"),
  wrap = require("../utils/asyncHandler"),
  limit = require("../middlewares/rateLimit.middleware"),
  { ok } = require("../utils/apiResponse");
const service = require("../services/experience.service"),
  { query, pool } = require("../config/db");
const read = (path, fn) =>
  router.get(
    path,
    auth,
    wrap(async (req, res) => ok(res, await fn(req))),
  );
const write = (method, path, fn) =>
  router[method](
    path,
    auth,
    limit({ max: 30 }),
    wrap(async (req, res) => ok(res, await fn(req))),
  );
read("/rooms/:roomId/settings", (r) =>
  service.settings(r.params.roomId, r.user.id),
);
write("patch", "/rooms/:roomId/notifications", (r) =>
  service.preferences(r.params.roomId, r.user.id, r.body),
);
write("patch", "/rooms/:roomId/retention", (r) =>
  service.retention(r.params.roomId, r.user.id, r.body.seconds),
);
read("/rooms/:roomId/policy", async (r) => {
  await service.member(pool, r.params.roomId, r.user.id);
  return (
    await query(
      "SELECT e.id,e.seconds,e.created_at,u.display_name FROM room_policy_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.room_id=$1 ORDER BY e.created_at DESC LIMIT 20",
      [r.params.roomId],
    )
  ).rows;
});
read(
  "/personal-settings",
  async (r) =>
    (
      await query(
        "SELECT custom_status,status_until,dnd_until FROM users WHERE id=$1",
        [r.user.id],
      )
    ).rows[0],
);
write("patch", "/personal-settings", (r) =>
  service.personalSettings(r.user.id, r.body),
);
read("/threads", (r) => service.threads(r.user.id, r.query));
read("/threads/:rootId", (r) =>
  service.thread(r.user.id, r.params.rootId, r.query.before),
);
write("post", "/threads/:rootId/read", (r) =>
  service.readThread(r.user.id, r.params.rootId, r.body.sequence),
);
read("/saved", (r) => service.saved(r.user.id, r.query.before));
write("post", "/saved-room", (r) => service.personalRoom(r.user.id));
write("post", "/reminders", (r) =>
  service.remind(r.user.id, r.body.messageId, r.body.dueAt),
);
read(
  "/reminders",
  async (r) =>
    (
      await query(
        "SELECT r.id,r.message_id,r.due_at,r.completed_at,r.cancelled_at,CASE WHEN message_visible(m.id,$1) THEN m.room_id END AS room_id FROM message_reminders r LEFT JOIN messages m ON m.id=r.message_id WHERE r.user_id=$1 ORDER BY r.created_at DESC LIMIT 100",
        [r.user.id],
      )
    ).rows,
);
write("delete", "/reminders/:id", async (r) => {
  service.validId(r.params.id);
  return (
    (
      await query(
        "UPDATE message_reminders SET cancelled_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id",
        [r.params.id, r.user.id],
      )
    ).rows[0] || { cancelled: true }
  );
});
write("post", "/schedules", (r) =>
  service.schedule(r.user.id, r.body.roomId, r.body.payload, r.body.dueAt),
);
read(
  "/schedules",
  async (r) =>
    (
      await query(
        "SELECT id,room_id,client_id,due_at,status,reason,created_at FROM scheduled_messages WHERE user_id=$1 ORDER BY due_at DESC LIMIT 100",
        [r.user.id],
      )
    ).rows,
);
write("delete", "/schedules/:id", (r) =>
  require("../services/experienceWorker.service").cancelSchedule(
    r.user.id,
    service.validId(r.params.id),
  ),
);
router.get(
  "/rooms/:roomId/thread-counts",
  auth,
  wrap(async (req, res) => {
    await service.member(pool, req.params.roomId, req.user.id);
    const ids =
      typeof req.query.ids === "string" ? req.query.ids.split(",") : [];
    if (!ids.length || ids.length > 200)
      throw new (require("../utils/ApiError"))(
        400,
        "Provide up to 200 thread roots",
      );
    ids.forEach(service.validId);
    const rows = (
      await query(
        `SELECT root.id,COUNT(reply.id)::int AS reply_count,COUNT(reply.id) FILTER(WHERE reply.sender_id<>$1 AND reply.room_sequence>COALESCE(tr.last_sequence,0))::int AS unread_count
 FROM messages root LEFT JOIN messages reply ON reply.thread_root_id=root.id AND reply.deleted_at IS NULL AND message_visible(reply.id,$1)
 LEFT JOIN thread_reads tr ON tr.root_id=root.id AND tr.user_id=$1
 WHERE root.id=ANY($2::uuid[]) AND root.room_id=$3 AND root.thread_root_id IS NULL AND root.deleted_at IS NULL AND message_visible(root.id,$1)
 GROUP BY root.id,tr.last_sequence`,
        [req.user.id, ids, req.params.roomId],
      )
    ).rows;
    return ok(res, { threads: rows });
  }),
);

read("/schedules/:id", async (r) => {
  service.validId(r.params.id);
  const row = (
    await query(
      "SELECT id,room_id,client_id,payload,status,due_at FROM scheduled_messages WHERE id=$1 AND user_id=$2",
      [r.params.id, r.user.id],
    )
  ).rows[0];
  if (!row)
    throw new (require("../utils/ApiError"))(404, "Schedule unavailable");
  return row;
});
write("post", "/schedules/:id/review", (r) =>
  service.schedule(
    r.user.id,
    r.body.roomId,
    r.body.payload,
    r.body.dueAt,
    service.validId(r.params.id),
  ),
);

module.exports = router;
