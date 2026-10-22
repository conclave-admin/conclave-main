const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');
// Top-level rather than lazily: poll.service imports nothing from this module,
// so unlike reaction.service there is no cycle to defer around.
const { attachPolls } = require('./poll.service');
const { attachReceiptSummaries } = require('./messageReceipt.service');
const attachPollsAndReceipts = async rows => attachReceiptSummaries(await attachPolls(rows));

// Message pins — the same two scopes and the same rules as decisionPin.service,
// applied to messages. Deliberately a near-copy rather than a shared abstraction:
// the two tables differ only in their parent, and a generic pinner over two
// shapes would need the policy parameterised for the sake of one call site.
//
//   'user'  a personal bookmark. Only its author sees it and only they remove
//           it. Nothing about the room changes.
//   'room'  a room-wide pin. Every member sees it in the panel under the room
//           header. At most one exists per message (migration 019).
//
// The wire shape attached to every message is identical to a decision's:
//
//   pins: {
//     room: { user_id, display_name, pinned_at } | null,
//     mine: ['user' | 'room', ...]
//   }
//
// `room` is shared truth and `mine` is per viewer, for the same reason as
// decisions: a client knows what it pinned but cannot know anyone else's.

const PIN_SCOPES = new Set(['user', 'room']);

function assertScope(scope) {
  if (!PIN_SCOPES.has(scope)) {
    throw new ApiError(400, "scope must be 'user' or 'room'");
  }
  return scope;
}

/**
 * Attach `pins` to each message, in place.
 *
 * Batched across the whole page for the same reason attachReactions is: one
 * query for N messages rather than N queries. `db` is accepted so the pin
 * routes can enlist in a transaction, exactly like the decision equivalent.
 *
 * @param {Array} messages - rows with an `id`
 * @param {string} viewerId - the caller, for `mine`
 * @param {object} [options] - `{ db }` to enlist in a transaction
 * @returns {Array} the same array
 */
async function attachPins(messages, viewerId, { db } = {}) {
  if (!messages || messages.length === 0) return messages;

  const run = db ? db.query.bind(db) : query;

  const { rows } = await run(
    `SELECT mp.message_id, mp.user_id, mp.scope, mp.pinned_at, u.display_name
       FROM message_pins mp
       INNER JOIN users u ON u.id = mp.user_id
      WHERE mp.message_id = ANY($1::uuid[])`,
    [messages.map((m) => m.id)],
  );

  const byMessage = new Map();
  for (const row of rows) {
    const entry = byMessage.get(row.message_id) || { room: null, mine: [] };
    if (row.scope === 'room') {
      entry.room = {
        user_id: row.user_id,
        display_name: row.display_name,
        pinned_at: row.pinned_at,
      };
      if (row.user_id === viewerId) entry.mine.push('room');
    } else if (row.user_id === viewerId) {
      entry.mine.push('user');
    }
    byMessage.set(row.message_id, entry);
  }

  for (const message of messages) {
    const entry = byMessage.get(message.id);
    message.pins = entry ? { room: entry.room, mine: entry.mine } : { room: null, mine: [] };
  }

  return messages;
}

/**
 * Pin, or read back, a message in the shape the timeline already uses.
 *
 * The mutation endpoints re-read through this rather than returning the
 * INSERT/UPDATE row, so the socket payload and the timeline's payload are the
 * same object and cannot drift — the rule messages.controller already applies
 * for edits and reactions.
 */
async function getMessageWithPins(messageId, viewerId) {
  const result = await query(
    `SELECT m.*, rm.role AS my_role, u.display_name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m
       INNER JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
       INNER JOIN users u ON u.id = m.sender_id
      WHERE m.id = $1`,
    [messageId, viewerId],
  );

  if (result.rows.length === 0) {
    throw new ApiError(404, 'Message not found');
  }

  const [message] = await attachPollsAndReceipts(await attachPins(result.rows, viewerId));
  return message;
}

/**
 * Set a pin. Idempotent for the caller's own pin.
 */
async function pinMessage({ messageId, userId, scope, io }) {
  assertScope(scope);

  const room = await query(`SELECT room_id FROM messages WHERE id = $1`, [messageId]);
  const roomId = room.rows[0]?.room_id;
  if (!roomId) throw new ApiError(404, 'Message not found');

  const membership = await query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId],
  );
  if (membership.rows.length === 0) {
    throw new ApiError(403, 'You are not a member of this room');
  }

  if (scope === 'room') {
    const existing = await query(
      `SELECT mp.user_id, u.display_name
         FROM message_pins mp
         INNER JOIN users u ON u.id = mp.user_id
        WHERE mp.message_id = $1 AND mp.scope = 'room'`,
      [messageId],
    );
    const held = existing.rows[0];
    if (held && held.user_id !== userId) {
      throw new ApiError(409, `Already pinned to the room by ${held.display_name}`);
    }
  }

  await query(
    `INSERT INTO message_pins (message_id, user_id, scope, pinned_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (message_id, user_id, scope)
     DO UPDATE SET pinned_at = NOW()`,
    [messageId, userId, scope],
  );

  const message = await getMessageWithPins(messageId, userId);
  if (io) io.to(roomId).emit('message:pinned', { message, scope, userId });

  return message;
}

/**
 * Remove a pin.
 *
 * Removing an absent pin succeeds with nothing to report, matching
 * unpinDecision and removeReaction — a 404 would turn a retried request into a
 * visible failure. The service returns null and the controller decides.
 */
async function unpinMessage({ messageId, userId, scope, io }) {
  assertScope(scope);

  const room = await query(`SELECT room_id FROM messages WHERE id = $1`, [messageId]);
  const roomId = room.rows[0]?.room_id;
  if (!roomId) throw new ApiError(404, 'Message not found');

  const existing = await query(
    `SELECT user_id FROM message_pins WHERE message_id = $1 AND scope = $2`,
    [messageId, scope],
  );
  const held = existing.rows[0];
  if (!held) return null;

  if (scope === 'user') {
    if (held.user_id !== userId) {
      throw new ApiError(403, 'That is not your bookmark');
    }
  } else if (held.user_id !== userId) {
    const role = await query(
      `SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [roomId, userId],
    );
    if (role.rows[0]?.role !== 'admin') {
      throw new ApiError(403, 'Only the pinner or a room admin can unpin this');
    }
  }

  await query(
    `DELETE FROM message_pins WHERE message_id = $1 AND scope = $2 RETURNING message_id`,
    [messageId, scope],
  );

  const message = await getMessageWithPins(messageId, userId);
  if (io) io.to(roomId).emit('message:unpinned', { message, scope, userId });

  return message;
}

/**
 * Every message in a room that has a room-wide pin, oldest first.
 *
 * Only room scope. A personal bookmark is nobody else's business, so listing it
 * here would leak what a member has saved for themselves.
 *
 * Returns the message rows the client already knows how to render — including
 * the sender, the reactions and the pins field itself — so the panel is the same
 * message component as the timeline rather than a second rendering of it.
 */
async function listRoomPins(roomId, viewerId) {
  const result = await query(
    `SELECT m.id, m.room_id, m.sender_id, m.client_id, m.album_id, m.forwarded, m.room_sequence, m.content, m.reply_to_id,
            m.edited_at, m.deleted_at, m.created_at,
            u.display_name AS sender_name, u.avatar_url AS sender_avatar
       FROM message_pins mp
       INNER JOIN messages m ON m.id = mp.message_id
       INNER JOIN users u ON u.id = m.sender_id
      WHERE mp.scope = 'room'
        AND m.room_id = $1
        -- Deleting a message tombstones it rather than removing the row, so the
        -- pin would outlive the text it refers to and the panel would keep a
        -- reference to something nobody can read. Dropped here rather than in
        -- the client so every consumer of this endpoint gets the same list.
        AND m.deleted_at IS NULL
      ORDER BY mp.pinned_at ASC`,
    [roomId],
  );

  if (result.rows.length === 0) return [];

  // Reactions come along so a pinned message renders identically to one in the
  // timeline. The membership check is the caller's; this is called only from a
  // route that has already done it.
  const { attachReactions } = require('./reaction.service');
  const messages = await attachReactions(result.rows, viewerId);

  return attachPollsAndReceipts(await attachPins(messages, viewerId));
}

module.exports = {
  attachPins,
  getMessageWithPins,
  pinMessage,
  unpinMessage,
  listRoomPins,
};
