// Use the same native sequences the client picker offers. Rejecting arbitrary
// strings at the API keeps reactions bounded without a hand-maintained SQL list.
// Emoji Mart's canonical sequences also avoid visually duplicate variants such
// as a bare heart and the fully qualified red heart.
const data = require("@emoji-mart/data");
const REACTION_EMOJI = [
  ...new Set(
    Object.values(data.emojis).flatMap((entry) =>
      entry.skins.map((skin) => skin.native),
    ),
  ),
];
const ALLOWED_EMOJI = new Set(REACTION_EMOJI);
const EMOJI_ORDER = new Map(
  REACTION_EMOJI.map((emoji, index) => [emoji, index]),
);

const { query } = require("../config/db");
const ApiError = require("../utils/ApiError");

/**
 * Throw unless `emoji` is one canonical native emoji from Emoji Mart.
 *
 * @param {string} emoji
 * @returns {string} the emoji, validated
 */
function assertAllowedEmoji(emoji) {
  if (typeof emoji !== "string" || !ALLOWED_EMOJI.has(emoji)) {
    throw new ApiError(400, "Choose a supported emoji reaction");
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
    const current = byEmoji.get(row.emoji) || {
      emoji: row.emoji,
      reactor_ids: [],
    };
    current.reactor_ids.push(row.user_id);
    byEmoji.set(row.emoji, current);
  }

  // Catalog order is stable and does not require scanning every available
  // emoji for every message page.
  const ordered = [...byEmoji.values()].sort(
    (a, b) =>
      (EMOJI_ORDER.get(a.emoji) ?? Infinity) -
      (EMOJI_ORDER.get(b.emoji) ?? Infinity),
  );

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
