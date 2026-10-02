const { pool, query } = require('../config/db');
const ApiError = require('../utils/ApiError');

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
 * @returns {object} The inserted message row enriched with sender info and attachments
 */
async function createMessage({ roomId, senderId, content, replyToId, attachments }) {
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

  // 3. Insert message + attachments in a transaction
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

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // 4. Fetch sender display_name + avatar for the broadcast
  const sender = await query(
    `SELECT display_name, avatar_url FROM users WHERE id = $1`,
    [senderId],
  );

  return {
    ...message,
    sender_name: sender.rows[0]?.display_name || null,
    sender_avatar: sender.rows[0]?.avatar_url || null,
    attachments: savedAttachments.map(serializeAttachment),
  };
}

module.exports = { createMessage };
