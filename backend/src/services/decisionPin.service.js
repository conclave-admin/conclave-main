const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');

// Decision pins — two scopes, one table.
//
//   'user'  a personal bookmark. Only its author sees it and only they remove
//           it. Nothing about the room changes.
//   'room'  a room-wide pin. Every member sees it in the strip under the room
//           header. At most one exists per decision (migration 014), so
//           "pinned to the room" is a state rather than a pile of endorsements.
//
// The wire shape attached to every decision is:
//
//   pins: {
//     room: { user_id, display_name, pinned_at } | null,
//     mine: ['user' | 'room', ...]
//   }
//
// `room` is shared truth — the same for every viewer, so it can be broadcast.
// `mine` is per viewer, exactly like reactions' `reacted`, which is why the
// socket events below carry `pins.room` and the acting user's id rather than a
// finished payload: each client knows what it pinned and can fix up its own
// `mine` without a second request, but it cannot know anyone else's.

const PIN_SCOPES = new Set(['user', 'room']);

function assertScope(scope) {
  if (!PIN_SCOPES.has(scope)) {
    throw new ApiError(400, "scope must be 'user' or 'room'");
  }
  return scope;
}

/**
 * Attach `pins` to each decision, in place.
 *
 * Two queries for the whole page rather than one per decision, mirroring
 * attachReactions. The room row is aggregated to one pin per decision here
 * rather than in the client, because migration 014 already guarantees there is
 * at most one — so the aggregate is a MAX() over a set of size one, and doing
 * it in SQL keeps one decision from rendering twice in the strip.
 *
 * @param {Array} decisions - rows with an `id`
 * @param {string} viewerId - the caller, for `mine`
 * @param {object} [options] - `{ db }` to enlist in a transaction
 * @returns {Array} the same array
 */
async function attachPins(decisions, viewerId, { db } = {}) {
  if (!decisions || decisions.length === 0) return decisions;

  const run = db ? db.query.bind(db) : query;

  const { rows } = await run(
    `SELECT dp.decision_id, dp.user_id, dp.scope, dp.pinned_at, u.display_name
       FROM decision_pins dp
       INNER JOIN users u ON u.id = dp.user_id
      WHERE dp.decision_id = ANY($1::uuid[])`,
    [decisions.map((d) => d.id)],
  );

  const byDecision = new Map();
  for (const row of rows) {
    const entry = byDecision.get(row.decision_id) || { room: null, mine: [] };
    if (row.scope === 'room') {
      // Shared truth, same for every viewer.
      entry.room = {
        user_id: row.user_id,
        display_name: row.display_name,
        pinned_at: row.pinned_at,
      };
      // A room pin the viewer set is both: everyone sees it, and they did it,
      // so they are allowed to take it back.
      if (row.user_id === viewerId) entry.mine.push('room');
    } else if (row.user_id === viewerId) {
      entry.mine.push('user');
    }
    byDecision.set(row.decision_id, entry);
  }

  for (const decision of decisions) {
    const entry = byDecision.get(decision.id);
    decision.pins = entry
      ? { room: entry.room, mine: entry.mine }
      : { room: null, mine: [] };
  }

  return decisions;
}

/**
 * Load one decision in the joined shape listDecisions returns, pins attached.
 *
 * Every mutating endpoint re-reads through this rather than returning the
 * INSERT or UPDATE row, so the REST response and the socket payload cannot
 * drift apart — the same rule messages.controller applies via
 * getMessagePayload.
 */
async function getDecisionPayload(decisionId, viewerId) {
  const result = await query(
    `SELECT d.*, r.name AS room_name, r.slug AS room_slug,
            u.display_name AS author_name
       FROM decisions d
       INNER JOIN rooms r ON r.id = d.room_id
       INNER JOIN users u ON u.id = d.created_by
      WHERE d.id = $1`,
    [decisionId],
  );

  if (result.rows.length === 0) {
    throw new ApiError(404, 'Decision not found');
  }

  const [decision] = await attachPins(result.rows, viewerId);
  return decision;
}

/**
 * Set a pin.
 *
 * Idempotent for the caller's own pin: a repeat PUT updates pinned_at rather
 * than erroring, so a double-tap or a retried request is not a failure. The
 * exception is a room pin someone else already holds — that is a 409 naming
 * them, because taking it over silently would move a shared affordance out
 * from under its owner.
 *
 * @param {{ decisionId: string, userId: string, scope: string, io?: object }} params
 */
async function pinDecision({ decisionId, userId, scope, io }) {
  assertScope(scope);

  // Membership of the decision's room gates both scopes. A personal bookmark
  // of a decision you cannot see is not a thing, so there is no lighter check.
  const membership = await query(
    `SELECT 1 FROM room_members rm
      WHERE rm.user_id = $2
        AND rm.room_id = (SELECT room_id FROM decisions WHERE id = $1)`,
    [decisionId, userId],
  );
  if (membership.rows.length === 0) {
    throw new ApiError(403, 'You are not a member of this room');
  }

  if (scope === 'room') {
    const existing = await query(
      `SELECT dp.user_id, u.display_name
         FROM decision_pins dp
         INNER JOIN users u ON u.id = dp.user_id
        WHERE dp.decision_id = $1 AND dp.scope = 'room'`,
      [decisionId],
    );
    const held = existing.rows[0];
    if (held && held.user_id !== userId) {
      throw new ApiError(409, `Already pinned to the room by ${held.display_name}`);
    }
  }

  await query(
    `INSERT INTO decision_pins (decision_id, user_id, scope, pinned_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (decision_id, user_id, scope)
     DO UPDATE SET pinned_at = NOW()`,
    [decisionId, userId, scope],
  );

  const decision = await getDecisionPayload(decisionId, userId);

  if (io) io.to(decision.room_id).emit('decision:pinned', { decision, scope, userId });

  return decision;
}

/**
 * Remove a pin.
 *
 * A personal pin has exactly one possible owner, so there is no permission to
 * check beyond the row existing for the caller. A room pin is moderation-shaped
 * — it changes what every member sees — so the author of the pin or a room
 * admin may remove it. An admin removing someone else's room pin is deliberate:
 * a pin left behind by a member who has since left the room would otherwise be
 * permanent.
 *
 * Removing an absent pin succeeds, matching removeReaction.
 *
 * @param {{ decisionId: string, userId: string, scope: string, io?: object }} params
 */
async function unpinDecision({ decisionId, userId, scope, io }) {
  assertScope(scope);

  const existing = await query(
    `SELECT dp.user_id FROM decision_pins dp
      WHERE dp.decision_id = $1 AND dp.scope = $2`,
    [decisionId, scope],
  );

  const held = existing.rows[0];

  if (scope === 'user') {
    if (!held) return null;
    if (held.user_id !== userId) {
      throw new ApiError(403, 'That is not your bookmark');
    }
  } else if (held && held.user_id !== userId) {
    const role = await query(
      `SELECT rm.role FROM room_members rm
        WHERE rm.user_id = $2
          AND rm.room_id = (SELECT room_id FROM decisions WHERE id = $1)`,
      [decisionId, userId],
    );
    if (role.rows[0]?.role !== 'admin') {
      throw new ApiError(403, 'Only the pinner or a room admin can unpin this');
    }
  }

  if (!held) return null;

  const removed = await query(
    `DELETE FROM decision_pins
      WHERE decision_id = $1 AND scope = $2
      RETURNING decision_id`,
    [decisionId, scope],
  );
  if (removed.rows.length === 0) return null;

  const roomId = await query(`SELECT room_id FROM decisions WHERE id = $1`, [decisionId]);
  const decision = await getDecisionPayload(decisionId, userId);

  if (io && roomId.rows[0]) {
    io.to(roomId.rows[0].room_id).emit('decision:unpinned', { decision, scope, userId });
  }

  return decision;
}

module.exports = { attachPins, getDecisionPayload, pinDecision, unpinDecision };
