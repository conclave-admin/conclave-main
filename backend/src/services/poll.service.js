const { pool, query } = require("../config/db");
const ApiError = require("../utils/ApiError");

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 12;
const MAX_QUESTION_LENGTH = 300;
const MAX_OPTION_LENGTH = 100;

/**
 * Validate and normalise a poll draft. Blank options are dropped, so a form
 * with an empty third row does not fail. Duplicates are rejected, because two
 * identical choices would split votes between buttons nobody can tell apart.
 */
function validatePollInput({ question, options, allowMultiple } = {}) {
  const text = typeof question === "string" ? question.trim() : "";
  if (!text) throw new ApiError(400, "A poll needs a question");
  if (text.length > MAX_QUESTION_LENGTH) {
    throw new ApiError(
      400,
      `The question is too long (max ${MAX_QUESTION_LENGTH} characters)`,
    );
  }

  if (!Array.isArray(options))
    throw new ApiError(400, "options must be an array");

  const labels = options
    .map((option) => (typeof option === "string" ? option.trim() : ""))
    .filter(Boolean);

  if (labels.length < MIN_OPTIONS) {
    throw new ApiError(400, `A poll needs at least ${MIN_OPTIONS} options`);
  }
  if (labels.length > MAX_OPTIONS) {
    throw new ApiError(400, `A poll can have at most ${MAX_OPTIONS} options`);
  }
  if (labels.some((label) => label.length > MAX_OPTION_LENGTH)) {
    throw new ApiError(
      400,
      `Each option must be ${MAX_OPTION_LENGTH} characters or fewer`,
    );
  }
  if (
    new Set(labels.map((label) => label.toLowerCase())).size !== labels.length
  ) {
    throw new ApiError(400, "Poll options must be different from each other");
  }

  return {
    question: text,
    options: labels,
    allowMultiple: Boolean(allowMultiple),
  };
}

/**
 * Write the poll and its options. Takes the caller's transaction client, so the
 * poll lives or dies with the message it belongs to.
 */
async function insertPoll(
  client,
  { messageId, roomId, userId, question, options, allowMultiple },
) {
  const poll = await client.query(
    `INSERT INTO polls (message_id, room_id, created_by, question, allow_multiple)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [messageId, roomId, userId, question, allowMultiple],
  );
  const pollId = poll.rows[0].id;

  await client.query(
    `INSERT INTO poll_options (poll_id, label, position)
     SELECT $1, t.label, (t.ord - 1)::smallint
       FROM unnest($2::text[]) WITH ORDINALITY AS t(label, ord)`,
    [pollId, options],
  );

  return pollId;
}

/**
 * Attach `poll` to each message: null for ordinary messages, and for a poll
 * the question, every option, and who voted for it. Batched like attachPins,
 * one query for the whole page.
 *
 * Nothing here depends on who is looking, so the same object can be
 * broadcast to the whole room.
 */
async function attachPolls(messages, { db } = {}) {
  if (!messages || messages.length === 0) return messages;

  const run = db ? db.query.bind(db) : query;
  const { rows } = await run(
    `SELECT p.id AS poll_id, p.message_id, p.question, p.allow_multiple, p.closed_at, p.created_by,
            o.id AS option_id, o.label,
            v.user_id AS voter_id, u.display_name AS voter_name, u.avatar_url AS voter_avatar
       FROM polls p
       INNER JOIN poll_options o ON o.poll_id = p.id
       LEFT JOIN poll_votes v ON v.option_id = o.id
       LEFT JOIN users u ON u.id = v.user_id
      WHERE p.message_id = ANY($1::uuid[])
      ORDER BY o.position ASC, v.created_at ASC`,
    [messages.map((message) => message.id)],
  );

  const byMessage = new Map();
  for (const row of rows) {
    let entry = byMessage.get(row.message_id);
    if (!entry) {
      entry = {
        poll: {
          id: row.poll_id,
          question: row.question,
          allow_multiple: row.allow_multiple,
          closed_at: row.closed_at,
          created_by: row.created_by,
          options: [],
          voter_count: 0,
        },
        voterIds: new Set(),
      };
      byMessage.set(row.message_id, entry);
    }

    let option = entry.poll.options.find(
      (candidate) => candidate.id === row.option_id,
    );
    if (!option) {
      option = { id: row.option_id, label: row.label, voters: [] };
      entry.poll.options.push(option);
    }

    if (row.voter_id) {
      option.voters.push({
        id: row.voter_id,
        display_name: row.voter_name,
        avatar_url: row.voter_avatar,
      });
      entry.voterIds.add(row.voter_id);
    }
  }

  for (const message of messages) {
    const entry = byMessage.get(message.id);
    if (entry) entry.poll.voter_count = entry.voterIds.size;
    message.poll = entry ? entry.poll : null;
  }

  return messages;
}

async function getPoll(messageId) {
  const [message] = await attachPolls([{ id: messageId }]);
  return message.poll;
}

/**
 * Replace this person's votes on a poll. An empty list removes their vote.
 *
 * "Replace" rather than "toggle one option" makes the call idempotent: a retry
 * after a dropped response cannot flip a vote the other way. The poll row is
 * locked for the duration, so two quick taps from one person cannot interleave.
 *
 * A non-member and a missing poll both get 404, so an outsider cannot learn
 * that a poll id exists.
 */
async function castVote({ pollId, userId, optionIds }) {
  if (optionIds !== undefined && !Array.isArray(optionIds)) {
    throw new ApiError(400, "optionIds must be an array");
  }
  const ids = [...new Set(optionIds || [])];
  if (ids.some((id) => typeof id !== "string")) {
    throw new ApiError(400, "optionIds must be an array of ids");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query(
      `SELECT p.id, p.message_id, p.room_id, p.allow_multiple, p.closed_at, m.deleted_at
         FROM polls p
         INNER JOIN messages m ON m.id = p.message_id
         INNER JOIN room_members rm ON rm.room_id = p.room_id AND rm.user_id = $2
        WHERE p.id = $1 AND message_visible(m.id,$2)
          FOR UPDATE OF p`,
      [pollId, userId],
    );
    const poll = found.rows[0];

    if (!poll || poll.deleted_at) throw new ApiError(404, "Poll not found");
    if (poll.closed_at) throw new ApiError(409, "This poll is closed");
    if (!poll.allow_multiple && ids.length > 1) {
      throw new ApiError(400, "This poll allows only one choice");
    }

    if (ids.length > 0) {
      const valid = await client.query(
        `SELECT id FROM poll_options WHERE poll_id = $1 AND id = ANY($2::uuid[])`,
        [pollId, ids],
      );
      if (valid.rows.length !== ids.length) {
        throw new ApiError(
          400,
          "One of those options does not belong to this poll",
        );
      }
    }

    await client.query(
      `DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2`,
      [pollId, userId],
    );

    if (ids.length > 0) {
      await client.query(
        `INSERT INTO poll_votes (poll_id, option_id, user_id)
         SELECT $1, o, $3 FROM unnest($2::uuid[]) AS o`,
        [pollId, ids, userId],
      );
    }

    await client.query("COMMIT");
    return { messageId: poll.message_id, roomId: poll.room_id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Close a poll. The person who made it, or a room admin, may do so. Closing
 * is one-way, and it keeps the results visible.
 */
async function closePoll({ pollId, userId }) {
  const found = await query(
    `SELECT p.message_id, p.room_id, p.created_by, rm.role
       FROM polls p
       INNER JOIN room_members rm ON rm.room_id = p.room_id AND rm.user_id = $2
      WHERE p.id = $1 AND message_visible(p.message_id,$2)`,
    [pollId, userId],
  );
  const poll = found.rows[0];

  if (!poll) throw new ApiError(404, "Poll not found");
  if (poll.created_by !== userId && poll.role !== "admin") {
    throw new ApiError(
      403,
      "Only the poll creator or a room admin can close it",
    );
  }

  await query(
    `UPDATE polls SET closed_at = COALESCE(closed_at, NOW()) WHERE id = $1`,
    [pollId],
  );
  return { messageId: poll.message_id, roomId: poll.room_id };
}

module.exports = {
  validatePollInput,
  insertPoll,
  attachPolls,
  getPoll,
  castVote,
  closePoll,
};
