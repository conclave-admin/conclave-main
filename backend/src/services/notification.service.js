// Notifications — writing a row, resolving it into something readable, and
// pushing it to the recipient.
//
// Three things here are less obvious than they look:
//
// 1. `reference_id` has NO foreign key. It is polymorphic (a message, a room, a
//    task, a decision) and nothing keeps it pointing at a live row, so a
//    notification whose message was deleted dangles. The resolver therefore
//    treats a missing target as normal and returns nulls — a notification is
//    never dropped just because its subject is gone.
//
// 2. `actor_id` is who CAUSED the notification, and it is the difference between
//    "Room invite" and "Victor invited you". It is not always derivable: for a
//    room_invite the inviter is recorded nowhere else, so the column is the only
//    place that knowledge exists. Migration 009 added it, and it cannot be
//    backfilled — rows written before it simply have no actor and render without
//    a name. For message-targeted types the sender is a sensible fallback.
//
// 3. The Socket.IO side is a per-user room named `user:<id>`, joined on connect in
//    sockets/index.js. Chat rooms are joined by raw room UUID, so the prefixed name
//    cannot collide with one.

const { pool } = require('../config/db');
const ApiError = require('../utils/ApiError');

// What each notification type points at. Adding a type means adding it here and
// writing a resolver branch; a type in the database with no entry here is
// rejected at write time rather than becoming a row nothing can render.
const MESSAGE_TARGET_TYPES = ['mention', 'new_message', 'file_uploaded'];
const ROOM_TARGET_TYPES = ['room_invite', 'member_joined'];

const NOTIFICATION_TYPES = [...MESSAGE_TARGET_TYPES, ...ROOM_TARGET_TYPES];

const TARGET_OF = {
  mention: 'message',
  new_message: 'message',
  file_uploaded: 'message',
  room_invite: 'room',
  member_joined: 'room',
};

// Long enough to render a line in the bell, short enough not to dump a whole
// message into a list view.
const PREVIEW_LENGTH = 120;

const personalRoom = (userId) => `user:${userId}`;

/**
 * Insert one notification row.
 *
 * @param {object} params
 * @param {string} params.recipientId  - who receives it
 * @param {string} params.type         - one of NOTIFICATION_TYPES
 * @param {string} [params.referenceId] - what it is about
 * @param {string} [params.actorId]    - who caused it, e.g. the admin who
 *                                       invited the recipient. Without this a
 *                                       room_invite cannot name its inviter.
 * @param {object} [params.db]         - pass a transaction client to enlist in
 *                                       an existing transaction; defaults to the pool
 * @returns {object} the inserted row
 */
async function createNotification({
  recipientId,
  type,
  referenceId = null,
  actorId = null,
  db,
}) {
  if (!recipientId) {
    throw new ApiError(400, 'recipientId is required');
  }
  if (!NOTIFICATION_TYPES.includes(type)) {
    throw new ApiError(400, `Unknown notification type "${type}"`);
  }
  if (actorId === recipientId) {
    // A notification you caused yourself is never useful — it would put an
    // unread row in the actor's own bell for their own action.
    throw new ApiError(400, 'actorId must differ from recipientId');
  }

  const run = db ? db.query.bind(db) : pool.query.bind(pool);
  const { rows } = await run(
    `INSERT INTO notifications (recipient_id, type, reference_id, actor_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, recipient_id, type, reference_id, actor_id, seen, created_at`,
    [recipientId, type, referenceId, actorId],
  );
  return rows[0];
}

function preview(content) {
  if (content === null || content === undefined) return null;
  const text = String(content).trim();
  if (text.length <= PREVIEW_LENGTH) return text;
  return `${text.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…`;
}

/**
 * Turn raw notification rows into the wire shape, resolving each row's subject.
 *
 * Batched by target type rather than one query with a LEFT JOIN per table: a
 * page of notifications realistically spans one to three types, so this is two
 * or three small `= ANY($1::uuid[])` queries instead of a wide join with a CASE
 * for every output column. It also keeps each type independently testable.
 *
 * A subject that no longer resolves yields null fields, never a dropped row.
 */
async function presentNotifications(rows, { db } = {}) {
  if (!rows || rows.length === 0) return [];

  const run = db ? db.query.bind(db) : pool.query.bind(pool);

  const messageIds = [];
  const roomIds = [];
  const actorIds = new Set();
  for (const row of rows) {
    if (row.actor_id) actorIds.add(row.actor_id);
    if (!row.reference_id) continue;
    if (TARGET_OF[row.type] === 'message') messageIds.push(row.reference_id);
    else if (TARGET_OF[row.type] === 'room') roomIds.push(row.reference_id);
  }

  // A soft-deleted message still resolves — the recipient should still see that
  // something happened, just without its content. So deleted_at is selected
  // rather than filtered. sender_name doubles as the actor fallback for rows
  // written before migration 009.
  const messages = new Map();
  if (messageIds.length > 0) {
    const { rows: found } = await run(
      `SELECT m.id,
              CASE WHEN m.deleted_at IS NOT NULL THEN NULL ELSE m.content END AS content,
              m.deleted_at IS NOT NULL AS is_deleted,
              m.room_id,
              r.name AS room_name,
              r.slug  AS room_slug,
              u.display_name AS sender_name
         FROM messages m
         LEFT JOIN rooms r ON r.id = m.room_id
         LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.id = ANY($1::uuid[])`,
      [messageIds],
    );
    for (const m of found) messages.set(m.id, m);
  }

  const rooms = new Map();
  if (roomIds.length > 0) {
    const { rows: found } = await run(
      `SELECT id, name, slug FROM rooms WHERE id = ANY($1::uuid[])`,
      [roomIds],
    );
    for (const r of found) rooms.set(r.id, r);
  }

  const actors = new Map();
  if (actorIds.size > 0) {
    const { rows: found } = await run(
      `SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`,
      [[...actorIds]],
    );
    for (const a of found) actors.set(a.id, a.display_name);
  }

  return rows.map((row) => {
    let context = {
      room_id: null,
      room_name: null,
      room_slug: null,
      actor_name: null,
      message_preview: null,
    };

    let senderName = null;
    if (row.reference_id && TARGET_OF[row.type] === 'message') {
      const m = messages.get(row.reference_id);
      if (m) {
        senderName = m.sender_name;
        context = {
          room_id: m.room_id,
          room_name: m.room_name,
          room_slug: m.room_slug,
          actor_name: null, // filled in below
          // null when the message was deleted, so the client can render a
          // tombstone instead of showing text the author retracted.
          message_preview: m.is_deleted ? null : preview(m.content),
        };
      }
    } else if (row.reference_id && TARGET_OF[row.type] === 'room') {
      const r = rooms.get(row.reference_id);
      if (r) {
        context = { ...context, room_id: r.id, room_name: r.name, room_slug: r.slug };
      }
    }

    // Whoever caused it, falling back to the message's sender when the row has
    // no explicit actor — which is every row written before migration 009. For
    // a mention that fallback is exactly right; for a room_invite it means
    // "Room invite" with no name, which is honest rather than wrong.
    context.actor_name = (row.actor_id && actors.get(row.actor_id)) || senderName || null;

    return {
      id: row.id,
      type: row.type,
      reference_id: row.reference_id,
      seen: row.seen,
      created_at: row.created_at,
      context,
    };
  });
}

async function presentNotification(row, options) {
  const [one] = await presentNotifications([row], options);
  return one;
}

/**
 * Push an already-presented notification to its recipient's personal room.
 * Emit the same shape the list endpoint returns, so the client can insert it
 * into its list without a second request or a translation step.
 *
 * recipientId is passed explicitly rather than read off the presented object:
 * that object deliberately omits it, because in a list every row is already the
 * caller's own.
 */
function emitNotification(io, recipientId, presented) {
  if (!io || !recipientId || !presented) return false;
  io.to(personalRoom(recipientId)).emit('notification', { notification: presented });
  return true;
}

/**
 * Create, resolve and push in one call — the common path for a REST handler
 * that wants the recipient told immediately.
 */
async function notifyAndEmit({ recipientId, type, referenceId, actorId, io, db }) {
  const row = await createNotification({ recipientId, type, referenceId, actorId, db });
  const presented = await presentNotification(row, { db });
  emitNotification(io, recipientId, presented);
  return presented;
}

module.exports = {
  NOTIFICATION_TYPES,
  MESSAGE_TARGET_TYPES,
  ROOM_TARGET_TYPES,
  personalRoom,
  createNotification,
  presentNotifications,
  presentNotification,
  emitNotification,
  notifyAndEmit,
  preview,
};
