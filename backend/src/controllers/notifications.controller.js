const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const ApiError = require('../utils/ApiError');
const {
  presentNotifications,
  emitNotificationsSeen,
} = require('../services/notification.service');

const PAGE_SIZE = 50;

// ---------- listNotifications ----------
// Newest first, with an unread count and an opaque cursor.
//
// The rows are resolved through presentNotifications, so every type gets its
// readable context (room name, actor name, message preview) here exactly as it
// was when emitted. The list payload and the socket payload are therefore
// byte-identical, which is what lets the client insert an incoming notification
// into this list without a refetch — the shape guarantee is the service's, and
// these two endpoints have to keep honouring it.
const listNotifications = asyncHandler(async (req, res) => {
  const { before, unseenOnly } = req.query;

  const params = [req.user.id];
  const filters = [`recipient_id = $1`];

  if (unseenOnly === 'true') {
    filters.push('seen = FALSE');
  }

  if (before) {
    // Compound cursor "<created_at>|<id>", the same convention as listMessages
    // (messages.controller.js). A bare created_at comparison skips rows when two
    // notifications share a timestamp, because `created_at < cursor` drops every
    // row equal to the cursor — including the one just returned. The id breaks the
    // tie. A cursor without the separator is still accepted, so a client holding
    // an older one keeps working.
    const sep = before.indexOf('|');
    if (sep === -1) {
      params.push(before);
      filters.push(`created_at < $${params.length}`);
    } else {
      params.push(before.slice(0, sep), before.slice(sep + 1));
      filters.push(
        `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
  }

  const result = await query(
    // PAGE_SIZE is passed as a parameter rather than interpolated, and it is
    // the only parameter — the cursor's own params are all $1..$n already. An
    // explicit ::int cast is required: Postgres will not infer a type for a bare
    // parameter in LIMIT and reports it as a uuid instead.
    `SELECT id, recipient_id, type, reference_id, actor_id, seen, created_at
     FROM notifications
     WHERE ${filters.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1}::int`,
    [...params, PAGE_SIZE],
  );
  const rows = result.rows;

  // Counted separately rather than derived from the page above: a COUNT over the
  // returned rows would report at most PAGE_SIZE and quietly cap the bell badge
  // at 50. This one is filtered only on unseen, never on `before`, because the
  // badge is a total — not "unseen among the 50 most recent".
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS unread_count
     FROM notifications
     WHERE recipient_id = $1 AND seen = FALSE`,
    [req.user.id],
  );

  const notifications = await presentNotifications(rows);
  const last = rows[rows.length - 1];
  // Only on a full page: a short page is the end of the walk, and handing back a
  // cursor there would send the client looking for rows that do not exist.
  const nextCursor =
    rows.length === PAGE_SIZE && last ? `${last.created_at}|${last.id}` : null;

  return ok(res, {
    notifications,
    unreadCount: countRows[0].unread_count,
    nextCursor,
  });
});

// ---------- markSeen ----------
// One notification or all of them.
//
// Both paths return the number of rows actually changed, so the client can adjust
// its badge without a second request. `updated` is the count of rows this call
// changed, not the total unseen afterwards — the client subtracts it.
const markSeen = asyncHandler(async (req, res) => {
  const { notificationId, all } = req.body || {};

  if (all !== true && !notificationId) {
    throw new ApiError(400, 'notificationId or all: true is required');
  }

  let result;
  if (all === true) {
    result = await query(
      `UPDATE notifications SET seen = TRUE
       WHERE recipient_id = $1 AND seen = FALSE`,
      [req.user.id],
    );
  } else {
    // Scoped to recipient_id as well as id. Without that any authenticated user
    // could mark somebody else's notification seen by guessing a UUID, and the
    // owner's unread count would silently drop.
    //
    // `AND seen = FALSE` keeps the return value meaningful: a repeated mark-all
    // reports 0 changed rather than claiming work it did not do.
    result = await query(
      `UPDATE notifications SET seen = TRUE
       WHERE id = $1 AND recipient_id = $2 AND seen = FALSE
       RETURNING id, recipient_id, type, reference_id, actor_id, seen, created_at`,
      [notificationId, req.user.id],
    );
  }

  if (all !== true && result.rows.length === 0) {
    // Either it does not exist, or it belongs to someone else, or it was already
    // seen. Indistinguishable from outside — and deliberately so, since saying
    // "not yours" would confirm the id exists.
    throw new ApiError(404, 'Notification not found');
  }

  const updated = result.rowCount;

  // For the caller's OTHER tabs — the same reason the bell needs a personal room
  // rather than a chat room. On `notification:seen`, NOT `notification`: that
  // event always carries a full row and clients append it straight to their list,
  // so reusing it here would insert a phantom `{ updated }` entry.
  const io = req.app.get('io');
  emitNotificationsSeen(io, req.user.id, updated);

  return ok(res, { updated });
});

module.exports = { listNotifications, markSeen };