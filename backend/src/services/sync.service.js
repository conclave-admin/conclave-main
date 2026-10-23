const { pool } = require("../config/db");
const ApiError = require("../utils/ApiError");
// No application writer takes this allocator lock. It only orders committed
// change rows, avoiding room-lock/allocator-lock deadlocks and late-commit gaps.
async function allocateCursors(limit = 1000) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(1835102825, 34)");
    const rows = await db.query(
      `WITH pending AS MATERIALIZED (
      SELECT id FROM sync_changes WHERE cursor IS NULL ORDER BY id LIMIT $1 FOR UPDATE
    ), numbered AS MATERIALIZED (SELECT id,nextval('sync_cursor_sequence') AS cursor FROM pending ORDER BY id)
    UPDATE sync_changes c SET cursor=n.cursor FROM numbered n WHERE c.id=n.id`,
      [limit],
    );
    await db.query("COMMIT");
    return rows.rowCount;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
// Cursor is global but changes are filtered again using CURRENT authorization.
// Removed members receive only their own membership invalidation, not messages.
const VISIBLE = `(c.user_id=$1 OR (NOT c.private AND (
  EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=c.room_id AND rm.user_id=$1)
  OR (c.kind='profile' AND EXISTS(SELECT 1 FROM room_members a JOIN room_members b ON b.room_id=a.room_id WHERE a.user_id=$1 AND b.user_id=c.user_id))
)))`;
async function replay(userId, after) {
  if (
    after !== undefined &&
    (typeof after !== "string" ||
      !/^\d{1,19}$/.test(after) ||
      BigInt(after) > 9223372036854775807n)
  )
    throw new ApiError(400, "Invalid synchronization cursor");
  await allocateCursors();
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const boundary = await db.query(
      "SELECT GREATEST(COALESCE(MAX(cursor),0),(SELECT floor FROM sync_retention))::text AS head, (SELECT floor::text FROM sync_retention) AS floor FROM sync_changes",
    );
    const { head, floor } = boundary.rows[0];
    if (
      after === undefined ||
      BigInt(after) < BigInt(floor) ||
      BigInt(after) > BigInt(head)
    ) {
      await db.query("COMMIT");
      return { reset: true, cursor: head, changes: [], hasMore: false };
    }
    const rows = await db.query(
      `SELECT cursor::text,kind,operation,entity_id,room_id,user_id FROM sync_changes c
      WHERE c.cursor>$2::bigint AND c.cursor<=$3::bigint AND ${VISIBLE} ORDER BY c.cursor LIMIT 201`,
      [userId, after, head],
    );
    const hasMore = rows.rows.length > 200;
    const changes = rows.rows.slice(0, 200);
    await db.query("COMMIT");
    return {
      reset: false,
      changes,
      cursor: hasMore ? changes.at(-1).cursor : head,
      hasMore,
    };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

async function recipients(change) {
  const result = await pool.query(
    `SELECT user_id FROM room_members WHERE room_id=$1
    UNION SELECT $2::uuid WHERE $2::uuid IS NOT NULL
    UNION SELECT a.user_id FROM room_members a JOIN room_members b ON b.room_id=a.room_id
      WHERE $3='profile' AND b.user_id=$2`,
    [change.private ? null : change.room_id, change.user_id, change.kind],
  );
  return result.rows.map((row) => row.user_id);
}
async function recoverMessageNotifications(id, io) {
  const result = await pool.query(
    `SELECT m.*, EXISTS(SELECT 1 FROM attachments WHERE message_id=m.id) AS has_file FROM messages m WHERE id=$1 AND deleted_at IS NULL`,
    [id],
  );
  const m = result.rows[0];
  if (!m) return;
  const rows = await pool.query(
    `SELECT r.recipient_id, EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=$1 AND mm.user_id=r.recipient_id) AS mentioned
    FROM message_recipients r JOIN room_members rm ON rm.room_id=$2 AND rm.user_id=r.recipient_id
    WHERE r.message_id=$1 AND NOT r.read`,
    [id, m.room_id],
  );
  const present = new Set(
    await require("./presence.service").getRoomViewingUsers(m.room_id),
  );
  for (const r of rows.rows) {
    if (!r.mentioned && present.has(r.recipient_id)) continue;
    await require("./notification.service").notifyAndEmit({
      recipientId: r.recipient_id,
      type: r.mentioned
        ? "mention"
        : m.has_file
          ? "file_uploaded"
          : "new_message",
      referenceId: m.id,
      actorId: m.sender_id,
      io,
    });
  }
}
async function dispatchChanges(io, limit = 100) {
  await allocateCursors();
  const { randomUUID } = require("node:crypto");
  const token = randomUUID();
  const claimed = await pool.query(
    `UPDATE sync_changes SET lease_until=NOW()+INTERVAL '60 seconds',lease_token=$2,attempts=attempts+1
    WHERE id IN (SELECT id FROM sync_changes WHERE cursor IS NOT NULL AND delivered_at IS NULL AND next_attempt_at<=NOW()
      AND (lease_until IS NULL OR lease_until<NOW()) ORDER BY cursor LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`,
    [limit, token],
  );
  for (const c of claimed.rows) {
    try {
      if (io && c.kind === "session")
        await require("./realtimeAccess.service").revokeSessionAccess(
          io,
          c.entity_id,
        );
      if (c.kind === "message" && c.operation === "INSERT")
        await recoverMessageNotifications(c.entity_id, io);
      if (io) {
        const adapter = io.of?.("/").adapter;
        if (adapter?.pubClient && !adapter.pubClient.isReady)
          throw new Error("Realtime transport unavailable");
        const users = await recipients(c);
        if (users.length)
          io.to(users.map((id) => `user:${id}`)).emit("sync:changed", {
            cursor: String(c.cursor),
          });
      }
      await pool.query(
        "UPDATE sync_changes SET delivered_at=NOW(),lease_until=NULL WHERE id=$1 AND lease_token=$2",
        [c.id, token],
      );
    } catch (error) {
      await pool.query(
        "UPDATE sync_changes SET lease_until=NULL,next_attempt_at=NOW()+($3::int*INTERVAL '1 second') WHERE id=$1 AND lease_token=$2",
        [c.id, token, Math.min(300, 2 ** Math.min(c.attempts, 8))],
      );
      console.error("Change delivery deferred", {
        changeId: c.id,
        message: error.message,
      });
    }
  }
  return claimed.rowCount;
}
async function pruneChanges() {
  // Keep undelivered and unassigned rows. A cursor behind the retained floor
  // forces full authorized reconciliation instead of silently skipping changes.
  await pool.query(`WITH removed AS (DELETE FROM sync_changes WHERE delivered_at IS NOT NULL AND created_at<NOW()-INTERVAL '30 days' RETURNING cursor)
    UPDATE sync_retention SET floor=GREATEST(floor,COALESCE((SELECT MAX(cursor) FROM removed),0))`);
}
let timer;
let work = Promise.resolve();
function start(io) {
  if (timer) return;
  let pruned = 0;
  const run = () => {
    work = work
      .then(async () => {
        await dispatchChanges(io);
        if (Date.now() - pruned > 3600000) {
          await pruneChanges();
          pruned = Date.now();
        }
      })
      .catch((e) => console.error("Change worker deferred", e.message));
  };
  timer = setInterval(run, 2000);
  timer.unref();
  run();
}
async function stop() {
  clearInterval(timer);
  timer = null;
  await work;
}
module.exports = {
  allocateCursors,
  replay,
  dispatchChanges,
  pruneChanges,
  start,
  stop,
};
