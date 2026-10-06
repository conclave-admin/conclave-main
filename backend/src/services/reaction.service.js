// Message reactions — the allowlist, and the one shape every surface returns.
//
// The table shipped in migration 001 with no validation and no writer, so the
// emoji column was free text and nothing read it. Two things are decided here so
// they cannot be decided twice:
//
// 1. Which emoji are allowed. Constrained in the schema by
//    message_reactions_emoji_check (migration 013), and re-checked in the
//    controller so the client gets a useful 400 instead of an opaque 23514.
//
//    A heart is deliberately absent. ❤️ has two encodings — U+2764 and U+2764
//    U+FE0F — and Postgres compares code points, so the two are different strings:
//    both can be inserted against a UNIQUE (message_id, user_id, emoji)
//    constraint, producing two rows for what looks like one reaction. The four
//    below each have exactly one byte sequence.
//
// 2. The wire shape. Aggregated in SQL rather than assembled client-side, so a
//    client does not have to count and re-group to render a chip. `reacted` is
//    per viewer, which is why it needs the caller's id and why the same message
//    has a different reaction shape for different people.
//
// The UNIQUE constraint is (message_id, user_id, emoji) and is named
// message_reactions_message_id_user_id_emoji_key by Postgres. It is named
// explicitly in ON CONFLICT rather than catching every violation as a 409,
// because a bare ON CONFLICT DO NOTHING would also swallow a genuine duplicate
// that ought to surface.

const REACTION_EMOJI = ['\u{1F44D}', '\u{1F44E}', '\u{1F389}', '\u{2705}'];

// Emojis with a variation-selector variant are excluded on purpose — see the
// header comment. Keep this list and migration 013 in step.
const ALLOWED_EMOJI = new Set(REACTION_EMOJI);

const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');

/**
 * Throw unless `emoji` is in the allowlist.
 *
 * The database enforces this too; this exists so an unknown emoji is a 400 with a
 * useful message rather than a 23514 mapped to "A field failed validation".
 *
 * @param {string} emoji
 * @returns {string} the emoji, validated
 */
function assertAllowedEmoji(emoji) {
  if (typeof emoji !== 'string' || !ALLOWED_EMOJI.has(emoji)) {
    throw new ApiError(
      400,
      `Unsupported reaction. Allowed: ${REACTION_EMOJI.join(' ')}`,
    );
  }
  return emoji;
}

/**
 * Aggregate reaction rows into the wire shape.
 *
 * One grouped query, so a message with many reactions is one row per emoji
 * rather than one per reaction. `reacted` is computed per viewer here because a
 * client cannot infer it from user_ids without doing the comparison itself on
 * every render.
 *
 * @param {Array} rows - rows of { message_id, emoji, reactor_ids }
 * @param {string} viewerId - the caller, or null when there is no session
 * @returns {Array} aggregated, in allowlist order so columns render stably
 */
function aggregateReactions(rows, viewerId = null) {
  if (!rows || rows.length === 0) return [];

  const byEmoji = new Map();
  for (const row of rows) {
    const current = byEmoji.get(row.emoji) || { emoji: row.emoji, reactor_ids: [] };
    current.reactor_ids.push(row.user_id);
    byEmoji.set(row.emoji, current);
  }

  // Ordered by the allowlist, not by row order, so the same message always
  // renders its chips in the same order.
  const ordered = REACTION_EMOJI
    .filter((emoji) => byEmoji.has(emoji))
    .map((emoji) => byEmoji.get(emoji));

  return ordered.map((entry) => ({
    emoji: entry.emoji,
    count: entry.reactor_ids.length,
    user_ids: entry.reactor_ids,
    reacted: viewerId ? entry.reactor_ids.includes(viewerId) : false,
  }));
}

/**
 * Attach a `reactions` array to each of `messages`, in place.
 *
 * One extra query for the whole page rather than a correlated subquery per
 * message: a page is 50 messages, so the subquery form would run 50 times, while
 * this runs once with `= ANY($1::uuid[])`. The aggregation itself then happens in
 * JS via aggregateReactions, which keeps the shape and the allowlist ordering in
 * one tested place instead of duplicated into SQL.
 *
 * Mutates and returns the same array, so call sites can `return ok(res, { messages })`
 * without a second variable.
 *
 * @param {Array} messages - message rows, each with an `id`
 * @param {string} viewerId  - the caller, for `reacted`
 * @param {object} [options] - `{ db }` to enlist in a transaction
 * @returns {Array} the same array
 */
async function attachReactions(messages, viewerId, { db } = {}) {
  if (!messages || messages.length === 0) return messages;

  const run = db ? db.query.bind(db) : query;
  const { rows } = await run(
    `SELECT message_id, user_id, emoji
     FROM message_reactions
     WHERE message_id = ANY($1::uuid[])`,
    [messages.map((m) => m.id)],
  );

  const byMessage = new Map();
  for (const row of rows) {
    const list = byMessage.get(row.message_id) || [];
    list.push(row);
    byMessage.set(row.message_id, list);
  }

  for (const message of messages) {
    message.reactions = aggregateReactions(
      byMessage.get(message.id) || [],
      viewerId,
    );
  }

  return messages;
}

module.exports = {
  REACTION_EMOJI,
  ALLOWED_EMOJI,
  assertAllowedEmoji,
  aggregateReactions,
  attachReactions,
};