const { pool, query } = require("../config/db");
const { createMessage } = require("./message.service");
let timer, running;
async function cancelSchedule(userId, id) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
    const row = (
      await db.query(
        "UPDATE scheduled_messages SET status='cancelled',payload=NULL,reason=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status IN('pending','sending','needs_review') RETURNING id",
        [id, userId],
      )
    ).rows[0];
    if (!row)
      throw new (require("../utils/ApiError"))(
        409,
        "This schedule was already sent or cancelled",
      );
    await db.query("COMMIT");
    return row;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
async function run(io) {
  // Leases and advisory locks make publication/cancellation safe across instances.
  for (let i = 0; i < 10; i++) {
    const job = (
      await query(`WITH due AS(SELECT id FROM scheduled_messages WHERE (status='pending' OR(status='sending' AND lease_until<NOW())) AND due_at<=NOW() ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT 1)
   UPDATE scheduled_messages s SET status='sending',lease_until=NOW()+INTERVAL '60 seconds' FROM due WHERE s.id=due.id RETURNING s.*`)
    ).rows[0];
    if (!job) break;
    const db = await pool.connect();
    try {
      await db.query("SELECT pg_advisory_lock(hashtext($1))", [job.id]);
      const current = (
        await db.query("SELECT * FROM scheduled_messages WHERE id=$1", [job.id])
      ).rows[0];
      if (current?.status !== "sending") continue;
      try {
        if (
          !(
            await query(
              "SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL",
              [job.user_id],
            )
          ).rowCount
        )
          throw new Error("Account is no longer active");
        const message = await createMessage({
          ...current.payload,
          senderId: job.user_id,
          io,
        });
        await query(
          "UPDATE scheduled_messages SET status='sent',payload=NULL,reason=NULL,updated_at=NOW(),lease_until=NULL WHERE id=$1",
          [job.id],
        );
        if (io)
          await require("./privacy.service").emitMessage(
            io,
            message.room_id,
            "new-message",
            message,
          );
      } catch (e) {
        const transient = !e.status && !/Account is no longer/.test(e.message);
        await query(
          `UPDATE scheduled_messages SET status=$2,reason=$3,updated_at=NOW(),lease_until=NULL,due_at=CASE WHEN $2='pending' THEN NOW()+INTERVAL '1 minute' ELSE due_at END WHERE id=$1`,
          [
            job.id,
            transient ? "pending" : "needs_review",
            transient
              ? "Server temporarily unavailable; delivery will be retried."
              : "Review needed: " +
                String(e.message || "Conversation access changed").slice(
                  0,
                  250,
                ),
          ],
        );
      }
    } finally {
      await db
        .query("SELECT pg_advisory_unlock(hashtext($1))", [job.id])
        .catch(() => {});
      db.release();
    }
  }
  // A reminder contains only a source ID. Normal notification authorization and
  // foreground/mute/DND policy still control delivery.
  for (let i = 0; i < 50; i++) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const reminder = (
        await db.query(
          "SELECT * FROM message_reminders WHERE due_at<=NOW() AND completed_at IS NULL AND cancelled_at IS NULL ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT 1",
        )
      ).rows[0];
      if (!reminder) {
        await db.query("COMMIT");
        break;
      }
      const visible = (
        await db.query(
          "SELECT 1 FROM messages WHERE id=$1 AND deleted_at IS NULL AND message_visible(id,$2)",
          [reminder.message_id, reminder.user_id],
        )
      ).rowCount;
      if (visible)
        await require("./notification.service").createNotification({
          recipientId: reminder.user_id,
          type: "reminder",
          referenceId: reminder.message_id,
          dedupeKey: `${reminder.user_id}:reminder:${reminder.id}`,
          db,
        });
      await db.query(
        "UPDATE message_reminders SET completed_at=NOW() WHERE id=$1",
        [reminder.id],
      );
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  // Room event reminders are durable, idempotent and re-check membership at
  // delivery. The worker lease allows all application instances to share work.
  await query(
    `UPDATE room_event_reminder_jobs j SET completed_at=NOW(),lease_until=NULL
     FROM room_events e WHERE e.id=j.event_id AND j.completed_at IS NULL
       AND (e.status<>'scheduled' OR e.starts_at<=NOW())`,
  );
  for (let i = 0; i < 50; i++) {
    const db = await pool.connect();
    let reminder;
    try {
      await db.query("BEGIN");
      reminder = (await db.query(
        `SELECT j.event_id,j.user_id FROM room_event_reminder_jobs j
         JOIN room_events e ON e.id=j.event_id
         WHERE j.due_at<=NOW() AND j.completed_at IS NULL
           AND (j.lease_until IS NULL OR j.lease_until<NOW())
           AND e.status='scheduled' AND e.starts_at>NOW()
         ORDER BY j.due_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
      )).rows[0];
      if (!reminder) { await db.query("COMMIT"); break; }
      await db.query("UPDATE room_event_reminder_jobs SET lease_until=NOW()+INTERVAL '60 seconds' WHERE event_id=$1 AND user_id=$2", [reminder.event_id, reminder.user_id]);
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
    try {
      const eligible = await query(
        `SELECT e.room_id FROM room_events e
         JOIN room_members rm ON rm.room_id=e.room_id AND rm.user_id=$2
         JOIN users u ON u.id=$2 AND u.deleted_at IS NULL AND u.suspended_at IS NULL
         JOIN room_event_reminder_jobs j ON j.event_id=e.id AND j.user_id=rm.user_id
         WHERE e.id=$1 AND j.user_id=$2 AND j.due_at<=NOW()
           AND e.status='scheduled' AND e.starts_at>NOW()
           AND e.reminder_at IS NOT NULL AND e.reminder_at<=NOW()`,
        [reminder.event_id, reminder.user_id],
      );
      if (eligible.rowCount) {
        await require("./notification.service").createNotification({
          recipientId: reminder.user_id,
          type: "event_reminder",
          referenceId: reminder.event_id,
          dedupeKey: `${reminder.user_id}:event-reminder:${reminder.event_id}`,
        });
        const notification = await query(
          `SELECT id,recipient_id,type,reference_id,actor_id,seen,created_at FROM notifications
           WHERE dedupe_key=$1`,
          [`${reminder.user_id}:event-reminder:${reminder.event_id}`],
        );
        if (notification.rows[0]) {
          const service = require("./notification.service");
          const presented = await service.presentNotification(notification.rows[0]);
          await service.emitNotification(io, reminder.user_id, presented);
        }
      }
      await query("UPDATE room_event_reminder_jobs SET completed_at=NOW(),lease_until=NULL WHERE event_id=$1 AND user_id=$2", [reminder.event_id, reminder.user_id]);
    } catch (error) {
      await query("UPDATE room_event_reminder_jobs SET lease_until=NOW()+INTERVAL '60 seconds' WHERE event_id=$1 AND user_id=$2", [reminder.event_id, reminder.user_id]);
      console.error("Room event reminder delivery deferred", { code: error.code || error.name });
    }
  }
  // Existing tombstone triggers enqueue unreferenced R2 cleanup transactionally.
  await query(`WITH expired AS(SELECT id FROM messages WHERE expires_at<=NOW() AND deleted_at IS NULL ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 200),
 tombstoned AS(UPDATE messages m SET content=NULL,deleted_at=NOW() FROM expired e WHERE m.id=e.id RETURNING m.id)
 DELETE FROM polls WHERE message_id IN(SELECT id FROM tombstoned)`);
}
function start(io) {
  if (timer) return;
  const tick = () => {
    if (running) return;
    running = run(io)
      .catch((e) =>
        console.error("Messaging background work failed", {
          code: e.code || e.name,
        }),
      )
      .finally(() => (running = null));
  };
  timer = setInterval(tick, 5000);
  timer.unref?.();
  tick();
}
async function stop() {
  clearInterval(timer);
  timer = null;
  await running;
}
module.exports = { run, start, stop, cancelSchedule };
