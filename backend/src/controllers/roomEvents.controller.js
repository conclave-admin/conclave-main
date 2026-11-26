const { pool, query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { createNotification, presentNotification, emitNotification } = require("../services/notification.service");
const { ok } = require("../utils/apiResponse");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function eventInput(body = {}) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const instant = (value, label, optional = false) => {
    if (optional && (value === undefined || value === null || value === "")) return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value))
      throw new ApiError(400, `${label} must include a date, time and time zone`);
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new ApiError(400, `Invalid ${label}`);
    return parsed;
  };
  const startsAt = instant(body.startsAt, "Start time");
  const endsAt = instant(body.endsAt, "End time", true);
  const reminderAt = instant(body.reminderAt, "Reminder time", true);
  const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "UTC";
  if (!title || title.length > 140 || description.length > 5000)
    throw new ApiError(400, "Add a title and keep event details within the allowed length");
  if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() <= Date.now())
    throw new ApiError(400, "Choose a future start time");
  if (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt <= startsAt))
    throw new ApiError(400, "The end time must be after the start time");
  if (reminderAt && (!Number.isFinite(reminderAt.getTime()) || reminderAt >= startsAt))
    throw new ApiError(400, "The reminder must be before the event starts");
  if (!timezone || timezone.length > 100) throw new ApiError(400, "Choose a valid time zone");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
  catch { throw new ApiError(400, "Choose a valid time zone"); }
  return { title, description, startsAt, endsAt, reminderAt, timezone };
}

async function emitEvent(io, roomId, eventId, kind) {
  if (!io) return;
  const { rows } = await query("SELECT user_id FROM room_members WHERE room_id=$1", [roomId]);
  io.to(rows.map(({ user_id }) => `user:${user_id}`)).emit("room:event", { roomId, eventId, kind });
}

const listEvents = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const result = await query(
    `SELECT e.id,e.room_id,e.created_by,e.title,e.description,e.starts_at,e.ends_at,e.timezone,
      e.reminder_at,e.status,e.created_at,e.updated_at,u.display_name AS organizer_name,
      own.response AS my_response,
      COUNT(r.event_id) FILTER(WHERE r.response='yes')::int AS yes_count,
      COUNT(r.event_id) FILTER(WHERE r.response='maybe')::int AS maybe_count,
      COUNT(r.event_id) FILTER(WHERE r.response='no')::int AS no_count
     FROM room_events e
     JOIN room_members mine ON mine.room_id=e.room_id AND mine.user_id=$2
     JOIN users u ON u.id=e.created_by
     LEFT JOIN room_event_rsvps own ON own.event_id=e.id AND own.user_id=$2
     LEFT JOIN room_event_rsvps r ON r.event_id=e.id
     WHERE e.room_id=$1 AND e.status='scheduled' AND e.starts_at>NOW()
     GROUP BY e.id,u.display_name,own.response
     ORDER BY e.starts_at,e.id LIMIT 100`,
    [roomId, req.user.id],
  );
  return ok(res, result.rows);
});

const createEvent = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const fields = eventInput(req.body);
  const client = await pool.connect();
  let event;
  try {
    await client.query("BEGIN");
    const membership = (await client.query(
      "SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE",
      [roomId, req.user.id],
    )).rows[0];
    if (!membership) throw new ApiError(403, "You are not a member of this room");
    event = (await client.query(
      `INSERT INTO room_events(room_id,created_by,title,description,starts_at,ends_at,timezone,reminder_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [roomId, req.user.id, fields.title, fields.description, fields.startsAt, fields.endsAt, fields.timezone, fields.reminderAt],
    )).rows[0];
    if (event.reminder_at) {
      await client.query(
        `INSERT INTO room_event_reminder_jobs(event_id,user_id,due_at)
         SELECT $1,rm.user_id,$2 FROM room_members rm WHERE rm.room_id=$3
         ON CONFLICT(event_id,user_id) DO UPDATE SET due_at=EXCLUDED.due_at,completed_at=NULL,lease_until=NULL`,
        [event.id, event.reminder_at, roomId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  await emitEvent(req.app.get("io"), roomId, event.id, "created");
  return ok(res, event, 201);
});

const updateEvent = asyncHandler(async (req, res) => {
  const { roomId, eventId } = req.params;
  const fields = eventInput(req.body);
  const client = await pool.connect();
  let event;
  try {
    await client.query("BEGIN");
    const current = (await client.query(
      `SELECT e.* FROM room_events e JOIN room_members rm ON rm.room_id=e.room_id AND rm.user_id=$3
       WHERE e.id=$1 AND e.room_id=$2 AND e.status='scheduled' FOR UPDATE OF e`,
      [eventId, roomId, req.user.id],
    )).rows[0];
    if (!current) throw new ApiError(404, "Event not found");
    const role = (await client.query("SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2", [roomId, req.user.id])).rows[0]?.role;
    if (current.created_by !== req.user.id && role !== "admin") throw new ApiError(403, "Only the organizer or a room admin can edit this event");
    event = (await client.query(
      `UPDATE room_events SET title=$3,description=$4,starts_at=$5,ends_at=$6,timezone=$7,reminder_at=$8,updated_at=NOW()
       WHERE id=$1 AND room_id=$2 RETURNING *`,
      [eventId, roomId, fields.title, fields.description, fields.startsAt, fields.endsAt, fields.timezone, fields.reminderAt],
    )).rows[0];
    await client.query("DELETE FROM room_event_reminder_jobs WHERE event_id=$1", [eventId]);
    if (event.reminder_at) await client.query(
      `INSERT INTO room_event_reminder_jobs(event_id,user_id,due_at)
       SELECT $1,rm.user_id,$2 FROM room_members rm WHERE rm.room_id=$3`,
      [eventId, event.reminder_at, roomId],
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await emitEvent(req.app.get("io"), roomId, eventId, "updated");
  return ok(res, event);
});

const cancelEvent = asyncHandler(async (req, res) => {
  const { roomId, eventId } = req.params;
  const result = await query(
    `UPDATE room_events e SET status='cancelled',updated_at=NOW()
     FROM room_members rm WHERE e.id=$1 AND e.room_id=$2 AND rm.room_id=e.room_id AND rm.user_id=$3
       AND e.status='scheduled' AND (e.created_by=$3 OR rm.role='admin') RETURNING e.id`,
    [eventId, roomId, req.user.id],
  );
  if (!result.rowCount) {
    const access = await query("SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2", [roomId, req.user.id]);
    if (!access.rowCount) throw new ApiError(403, "You are not a member of this room");
    throw new ApiError(404, "Event not found or you cannot cancel it");
  }
  await query("DELETE FROM room_event_reminder_jobs WHERE event_id=$1", [eventId]);
  const audience = await query("SELECT user_id FROM room_members WHERE room_id=$1 AND user_id<>$2", [roomId, req.user.id]);
  const io = req.app.get("io");
  for (const { user_id: recipientId } of audience.rows) {
    const notification = await createNotification({
      recipientId,
      type: "event_cancelled",
      referenceId: eventId,
      actorId: req.user.id,
      dedupeKey: `${recipientId}:event-cancelled:${eventId}`,
    });
    await emitNotification(io, recipientId, await presentNotification(notification));
  }
  await emitEvent(io, roomId, eventId, "cancelled");
  return ok(res, { cancelled: true });
});

const respondToEvent = asyncHandler(async (req, res) => {
  const { roomId, eventId } = req.params;
  const response = req.body?.response;
  if (!["yes", "maybe", "no"].includes(response)) throw new ApiError(400, "Choose yes, maybe, or no");
  const result = await query(
    `INSERT INTO room_event_rsvps(event_id,user_id,response)
     SELECT e.id,$3,$4 FROM room_events e JOIN room_members rm ON rm.room_id=e.room_id AND rm.user_id=$3
     WHERE e.id=$1 AND e.room_id=$2 AND e.status='scheduled' AND e.starts_at>NOW()
     ON CONFLICT(event_id,user_id) DO UPDATE SET response=EXCLUDED.response,updated_at=NOW()
     RETURNING event_id,response,updated_at`,
    [eventId, roomId, req.user.id, response],
  );
  if (!result.rowCount) throw new ApiError(404, "Event not found or room access changed");
  await emitEvent(req.app.get("io"), roomId, eventId, "rsvp");
  return ok(res, result.rows[0]);
});

module.exports = { listEvents, createEvent, updateEvent, cancelEvent, respondToEvent };
