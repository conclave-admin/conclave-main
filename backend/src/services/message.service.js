const { pool, query } = require('../config/db');
const ApiError = require('../utils/ApiError');
const { notifyAndEmit } = require('./notification.service');
const { isMentioned } = require('./mention.service');
const { attachReactions } = require('./reaction.service');

// Kept in step with the multer limit in routes/upload.routes.js.
const MAX_ATTACHMENTS = 10;

/**
 * Validate a client-supplied attachment list. Returns a normalised array of
 * `{ url }`.
 *
 * Since POST /upload (BACKEND_TASKS.md item C) the URL is a lookup key into
 * `file_uploads`, not a value we store on trust — claimUploads() resolves the
 * real filename/mime_type/size from the upload record inside the same
 * transaction that inserts the message. So this only has to check shape: the
 * client sends `url` alone, and anything else it sends is ignored.
 */
function validateAttachments(attachments) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) {
    throw new ApiError(400, 'attachments must be an array');
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new ApiError(400, `Too many attachments (max ${MAX_ATTACHMENTS})`);
  }

  const urls = [];
  for (const a of attachments) {
    if (!a || typeof a !== 'object') {
      throw new ApiError(400, 'Each attachment must be an object with a url');
    }
    if (typeof a.url !== 'string' || !a.url.trim()) {
      throw new ApiError(400, 'Each attachment requires a url');
    }
    urls.push(a.url.trim());
  }

  return urls;
}

/**
 * Map an `attachments` row to the shape the client expects. Mirrors the
 * json_build_object in messages.controller.listMessages so history loads
 * and live socket messages agree (BACKEND_TASKS.md Bug 6).
 */
function serializeAttachment(row) {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size_bytes,
    mime_type: row.file_type,
    url: row.file_url,
  };
}

/**
 * Persist a message and return the full row with sender metadata.
 * Used by both messages.controller.sendMessage (REST) and
 * sockets/index.js send-message event — never broadcast unsaved
 * client input; always write through this function.
 *
 * @param {object} params
 * @param {string} params.roomId
 * @param {string} params.senderId - UUID of the sending user
 * @param {string} params.content   - message body text
 * @param {string} [params.replyToId] - UUID of the message being replied to
 * @param {Array}  [params.attachments] - array of { url } from POST /upload
 * @param {Array}  [params.mentionedUserIds] - ids of users this message mentions.
 *   When omitted, mentions are inferred from the text — see resolveMentionIds
 *   for why that fallback exists and when it goes away.
 * @param {object} [params.io] - Socket.IO instance, used only to push mention
 *   notifications. Optional: the notification row is written either way, and
 *   without it the mentions simply are not pushed live.
 * @returns {object} The inserted message row enriched with sender info and attachments
 */
async function createMessage({ roomId, senderId, content, replyToId, attachments, mentionedUserIds, io }) {
  const cleanAttachments = validateAttachments(attachments);
  const hasContent = typeof content === 'string' && content.trim().length > 0;

  // A message may be file-only (BACKEND_TASKS.md Bug 8) — the dev fixtures
  // include one. It may not be empty in both senses.
  if (!hasContent && cleanAttachments.length === 0) {
    throw new ApiError(
      400,
      'Message content is required unless there is at least one attachment'
    );
  }

  // 1. Verify room exists and sender is a member (1 query)
  const membership = await query(
    `SELECT r.id AS room_id
     FROM rooms r
     INNER JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = $2
     WHERE r.id = $1`,
    [roomId, senderId],
  );

  if (membership.rows.length === 0) {
    throw new ApiError(404, 'Room not found or you are not a member');
  }

  // 2. If replying, verify the parent message exists in the same room
  if (replyToId) {
    const parent = await query(
      `SELECT id FROM messages WHERE id = $1 AND room_id = $2`,
      [replyToId, roomId],
    );
    if (parent.rows.length === 0) {
      throw new ApiError(400, 'Reply target message not found in this room');
    }
  }

  // 3. Work out who is mentioned, before the insert, so the rows can be written
  //    in the same transaction as the message.
  const mentionedIds = await resolveMentionIds({
    roomId, senderId, content, mentionedUserIds,
  });

  // 4. Insert message + attachments in a transaction
  const client = await pool.connect();
  let message;
  let savedAttachments = [];

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO messages (room_id, sender_id, content, reply_to_id)
       VALUES ($1, $2, $3, $4)
       RETURNING
         id, room_id, sender_id, content, reply_to_id,
         edited_at, deleted_at, created_at`,
      [roomId, senderId, hasContent ? content.trim() : null, replyToId || null],
    );
    message = result.rows[0];

    // Claim each upload before inserting its attachment row. One statement does
    // the lookup, the ownership check and the one-time-use check: the
    // `attached_message_id IS NULL` predicate takes a row lock, so two messages
    // sent concurrently cannot both win the same upload.
    //
    // Zero rows means one of three things — the URL was never uploaded, it
    // belongs to somebody else, or it is already attached — and the client
    // cannot tell which from outside. All three are the same failure here, so
    // they share one message and the transaction rolls back.
    for (const url of cleanAttachments) {
      const claim = await client.query(
        `UPDATE file_uploads
            SET attached_message_id = $2
          WHERE file_url = $1
            AND uploader_id = $3
            AND attached_message_id IS NULL
          RETURNING filename, mime_type, size_bytes`,
        [url, message.id, senderId],
      );

      if (claim.rows.length === 0) {
        throw new ApiError(
          400,
          'Attachment is unavailable: it was never uploaded, was uploaded by another user, or is already attached to a message'
        );
      }

      // filename/mime_type/size come from the upload record, never the request.
      // Otherwise a client could attach someone else's real URL while claiming
      // it is a PDF, and the stored metadata would be whatever it posted.
      const owned = claim.rows[0];
      const attResult = await client.query(
        `INSERT INTO attachments (message_id, filename, file_url, file_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, filename, file_url, file_type, size_bytes`,
        [message.id, owned.filename, url, owned.mime_type, owned.size_bytes ?? null],
      );
      savedAttachments.push(attResult.rows[0]);
    }

    for (const mentionedId of mentionedIds) {
      await client.query(
        `INSERT INTO message_mentions (message_id, user_id)
         VALUES ($1, $2)
         -- Already claimed by an earlier attachment-free path or a retry; the
         -- composite primary key means a duplicate mention is not an error.
         ON CONFLICT DO NOTHING`,
        [message.id, mentionedId],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // 6. Fetch sender display_name + avatar for the broadcast
  const sender = await query(
    `SELECT display_name, avatar_url FROM users WHERE id = $1`,
    [senderId],
  );

  // 7. Notify the people recorded as mentioned. After the commit, so a mention is
  //    never announced for a message that rolled back.
  //
  //    Driven by `mentionedIds` — the same list written to message_mentions — not
  //    by a second pass over the room members. Resolving mentions twice is how the
  //    two would come to disagree.
  //
  //    Runs whether or not `io` was supplied. The notification ROW is the source
  //    of truth — it is what the list endpoint reads and what survives until
  //    seen — while the socket push is only delivery. Gating the whole thing on
  //    `io` would mean a mention sent over a path that passes no socket is
  //    silently never recorded, which is exactly the class of bug that left
  //    room_invite unreadable for two items.
  //
  //    Best-effort: a notification failure must not fail the send. The message is
  //    the user's actual intent and is already durable at this point, so losing a
  //    bell entry is strictly better than reporting a failed send for a message
  //    that exists.
  await notifyMentions({ message, mentionedIds, senderId, io });

  // Reactions are attached for the same reason the other payload fields are: all
  // six surfaces return one message shape, and a message that was just created has
  // none, so this is always [].
  const [payload] = await attachReactions([{
    ...message,
    sender_name: sender.rows[0]?.display_name || null,
    sender_avatar: sender.rows[0]?.avatar_url || null,
    attachments: savedAttachments.map(serializeAttachment),
    // Exposed so the client can style a real mention rather than regex-matching
    // the text, and so a client can learn which ids a send actually resolved to.
    mentioned_user_ids: mentionedIds,
  }], senderId);

  return payload;
}

/**
 * Decide which users a message mentions, as ids.
 *
 * Preferred path: the client sends `mentionedUserIds`, because only the client
 * knows who the user actually picked from autocomplete. A display name is not an
 * identity — it is not even unique — so text cannot express "this person".
 *
 * TEMPORARY FALLBACK: when no ids are sent, mentions are inferred from the text
 * with the old regex. This exists only so existing clients keep working; the sole
 * client send path (client/src/hooks/useMessages.js) does not send ids yet.
 *
 * Remove the fallback when that hook passes `mentionedUserIds`. Until then a
 * rename still misdirects mentions for messages sent without ids — that is the
 * bug item H exists to fix, and the fallback is what keeps it alive in a
 * time-boxed way rather than a permanent one. The digest does NOT have this
 * fallback: it reads message_mentions only, so history never re-derives mentions
 * from text.
 *
 * Ids that are not room members are dropped rather than rejected. A stale or
 * hostile id list must not fail an otherwise-valid send — the message itself is
 * fine, and someone merely removed from the room should not receive mentions.
 * The sender is excluded for the same reason createNotification would reject a
 * self-mention: an unread row in your own bell for your own message.
 *
 * @returns {Promise<string[]>} de-duplicated ids, empty if none
 */
async function resolveMentionIds({ roomId, senderId, content, mentionedUserIds }) {
  let candidates = null;

  if (Array.isArray(mentionedUserIds) && mentionedUserIds.length > 0) {
    candidates = mentionedUserIds.filter(
      (id) => typeof id === 'string' && id !== senderId,
    );
  } else {
    // Fallback: text matching against the room's members.
    const text = typeof content === 'string' ? content.trim() : '';
    // Cheap pre-check, and it skips a query on every ordinary message.
    if (!text.includes('@')) return [];

    const members = await query(
      `SELECT rm.user_id, u.display_name
       FROM room_members rm
       INNER JOIN users u ON u.id = rm.user_id AND u.deleted_at IS NULL
       WHERE rm.room_id = $1 AND rm.user_id <> $2`,
      [roomId, senderId],
    );
    candidates = members.rows
      .filter((m) => isMentioned(text, m.display_name))
      .map((m) => m.user_id);
  }

  if (candidates.length === 0) return [];

  // One membership check for the whole list. `= ANY($1::uuid[])` rather than one
  // query per id, and it is what turns an unverifiable id into silence.
  const members = await query(
    `SELECT user_id
     FROM room_members
     WHERE room_id = $1 AND user_id = ANY($2::uuid[])`,
    [roomId, candidates],
  );

  return [...new Set(members.rows.map((r) => r.user_id))];
}

/**
 * Create and push a `mention` notification for each id resolved for this message.
 */
async function notifyMentions({ message, mentionedIds, senderId, io }) {
  const notified = [];
  for (const recipientId of mentionedIds) {
    try {
      await notifyAndEmit({
        recipientId,
        type: 'mention',
        referenceId: message.id,
        actorId: senderId,
        io,
      });
      notified.push(recipientId);
    } catch (err) {
      // One recipient failing must not abort the others — a duplicate key or a
      // member removed between the lookup and the write should cost one bell
      // entry, not all of them.
      console.error('Mention notification failed', err);
    }
  }
  return notified;
}


/**
 * One query that loads a message and proves the caller may act on it.
 *
 * `requireAdmin` is how the two entry points differ: an author may always edit or
 * delete their own message, while a room admin may act on anyone's. The
 * membership join is what makes a message in a room you are not in a 404 rather
 * than a 403 — the same reasoning as updateTaskStatus, so the endpoint does not
 * confirm that an id exists somewhere you cannot see.
 *
 * @returns {object} the message row
 */
async function loadMessageForAction({ messageId, userId, requireAdmin = false }) {
  const result = await query(
    `SELECT m.id, m.room_id, m.sender_id, m.deleted_at,
            (m.sender_id = $2) AS is_author,
            (rm.role = 'admin') AS is_room_admin
     FROM messages m
     INNER JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
     WHERE m.id = $1`,
    [messageId, userId],
  );

  if (result.rows.length === 0) {
    throw new ApiError(404, 'Message not found');
  }

  const row = result.rows[0];
  const permitted = requireAdmin
    ? row.is_author || row.is_room_admin
    : row.is_author;

  if (!permitted) {
    // 403 rather than 404 here: the message exists and you can see it, the issue
    // is what you are allowed to do to it. Distinguishing that from the 404 above
    // is deliberate — hiding existence you already know about helps nobody.
    throw new ApiError(
      403,
      requireAdmin
        ? 'Only the author or a room admin can delete this message'
        : 'You can only edit your own messages',
    );
  }

  return row;
}

/**
 * Edit a message's text.
 *
 * Author-only, no time limit, and the whole body is replaced rather than patched.
 *
 * Mentions and notifications are deliberately left alone. A notification cannot
 * be unsent, so editing "@Amina" out of a message must not silently rewrite who
 * was told about it — and re-deriving mentions here would make the text the source
 * of truth again, undoing item H. message_mentions rows and existing `mention`
 * notifications both survive an edit, by design.
 *
 * `attachments` and `mentionedUserIds` are not editable: both are recorded facts
 * about the send, not the current text.
 *
 * @returns {object} the updated message row
 */
async function editMessage({ messageId, userId, content }) {
  if (typeof content !== 'string') {
    throw new ApiError(400, 'content must be a string');
  }
  const trimmed = content.trim();

  const existing = await loadMessageForAction({ messageId, userId });

  if (existing.deleted_at) {
    // A tombstone has nothing to edit. Allowing it would mean a deleted message
    // could be brought back to life with content nobody else can see.
    throw new ApiError(400, 'Cannot edit a deleted message');
  }

  // Same rule as createMessage (Bug 8): a message may be file-only, so empty
  // content is only acceptable when there is an attachment carrying it.
  if (!trimmed) {
    const attachments = (
      await query('SELECT 1 FROM attachments WHERE message_id = $1 LIMIT 1', [messageId])
    ).rows;
    if (attachments.length === 0) {
      throw new ApiError(
        400,
        'content cannot be empty unless the message has an attachment',
      );
    }
  }

  const result = await query(
    `UPDATE messages
        SET content = $2, edited_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, room_id, sender_id, content, reply_to_id, edited_at, deleted_at, created_at`,
    [messageId, trimmed || null],
  );

  return result.rows[0];
}

/**
 * Soft-delete a message. Author or room admin.
 *
 * `content` is overwritten rather than merely hidden. Leaving retracted text in
 * the column means anyone with SQL can still read it, which is not what "delete"
 * means to the person who pressed the button — and it matches what deleteMe
 * already does to display_name and email. The read side already withheld the body
 * via `CASE WHEN deleted_at IS NOT NULL`, so overwriting changes nothing a client
 * can observe, only what the database still holds.
 *
 * Attachments and message_mentions rows are left in place. The digest already
 * filters `deleted_at IS NULL`, so the message leaves digests correctly, and its
 * Cloudinary asset and provenance are not destroyed by a moderation action. The
 * message itself stays in history as a tombstone so replies and ordering hold.
 *
 * @returns {object} the updated message row
 */
async function deleteMessage({ messageId, userId }) {
  const existing = await loadMessageForAction({ messageId, userId, requireAdmin: true });

  const result = await query(
    `UPDATE messages
        SET deleted_at = NOW(), content = NULL
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, room_id, sender_id, content, reply_to_id, edited_at, deleted_at, created_at`,
    [messageId],
  );

  // A concurrent delete by someone else already won. Reporting success is
  // correct — the caller wanted it deleted, and it is — but there is nothing to
  // return as changed.
  return result.rows[0] || existing;
}

/**
 * Add a reaction. Idempotent: reacting twice with the same emoji is not an error
 * and does not stack.
 *
 * Room membership is required, but membership is not otherwise special — reacting
 * is not a moderation action, so a room admin gets no additional power here.
 *
 * @returns {object} the reaction row
 */
async function addReaction({ messageId, userId, emoji }) {
  const membership = await query(
    `SELECT 1
     FROM messages m
     INNER JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
     WHERE m.id = $1 AND m.deleted_at IS NULL`,
    [messageId, userId],
  );
  if (membership.rows.length === 0) {
    // Covers "no such message", "not a member of that room", and "already
    // deleted" as one 404 — a tombstone should not accept new reactions, and
    // there is no useful distinction to draw for the caller.
    throw new ApiError(404, 'Message not found');
  }

  // Qualified on the right-hand side: a bare `SET created_at = created_at` is
  // rejected by Postgres as an ambiguous column reference. Written this way the
  // timestamp of the ORIGINAL reaction is preserved when someone re-reacts with an
  // emoji they already used, which is what "no change" should mean.
  const result = await query(
    `INSERT INTO message_reactions (message_id, user_id, emoji)
     VALUES ($1, $2, $3)
     ON CONFLICT (message_id, user_id, emoji)
     DO UPDATE SET created_at = message_reactions.created_at
     RETURNING id, message_id, user_id, emoji, created_at`,
    [messageId, userId, emoji],
  );

  return result.rows[0];
}

/**
 * Remove one of the caller's reactions. Idempotent in effect: removing a
 * reaction that is not there succeeds, because the caller wanted it gone.
 *
 * @returns {boolean} whether a row was actually removed
 */
async function removeReaction({ messageId, userId, emoji }) {
  const result = await query(
    `DELETE FROM message_reactions
      WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
    [messageId, userId, emoji],
  );
  return result.rowCount > 0;
}

module.exports = {
  createMessage,
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
};
