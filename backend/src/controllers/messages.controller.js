const { query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const ApiError = require("../utils/ApiError");
const {
  createMessage,
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
} = require("../services/message.service");
const { assertAllowedEmoji, attachReactions } = require("../services/reaction.service");

const PAGE_SIZE = 50;

// ---------- sendMessage ----------
// REST fallback for sending a message — the primary path is the
// send-message Socket.IO event (see src/sockets/index.js). Both
// write through message.service.createMessage so history stays consistent.
const sendMessage = asyncHandler(async (req, res) => {
  const { roomId } = req.body;
  const { content, replyToId, attachments, mentionedUserIds } = req.body;

  if (!roomId) {
    throw new ApiError(400, "roomId is required");
  }

  const message = await createMessage({
    roomId,
    senderId: req.user.id,
    content,
    replyToId,
    attachments,
    mentionedUserIds,
    io: req.app.get("io"),
  });

  return ok(res, message, 201);
});

// ---------- listMessages ----------
// Cursor-paginated message history for a room. The client sends
// `?before=<ISO timestamp>` to page backwards through time.
// Returns newest-first, with the most recent PAGE_SIZE messages by default.
const listMessages = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const { before } = req.query; // ISO timestamp cursor

  // 1. Verify the caller is a member of this room
  const membership = await query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, req.user.id],
  );
  if (membership.rows.length === 0) {
    throw new ApiError(403, "You are not a member of this room");
  }

  // 2. Fetch messages — cursor-based pagination via created_at
  let sql = `
    SELECT
      m.id,
      m.room_id,
      m.sender_id,
      u.display_name AS sender_name,
      u.avatar_url   AS sender_avatar,
      -- Deleted messages stay in the timeline (so replies and ordering hold)
      -- but their body is withheld. is_deleted lets the client render a
      -- tombstone — see BACKEND_TASKS.md Bug 7.
      CASE WHEN m.deleted_at IS NOT NULL THEN NULL ELSE m.content END AS content,
      m.deleted_at IS NOT NULL AS is_deleted,
      m.reply_to_id,
      m.edited_at,
      m.deleted_at,
      m.created_at,
      COALESCE(
        json_agg(
          json_build_object(
            'id',        a.id,
            'filename',  a.filename,
            'size',      a.size_bytes,
            'mime_type', a.file_type,
            'url',       a.file_url
          )
        ) FILTER (WHERE a.id IS NOT NULL),
        '[]'
      ) AS attachments,
      -- Who this message mentions, by id. Lets the client style a real mention
      -- instead of regex-matching the text, which cannot distinguish two members
      -- who share a display name. Empty array, never null, so the client can map
      -- over it unconditionally.
      COALESCE(
        (
          SELECT json_agg(mm.user_id)
          FROM message_mentions mm
          WHERE mm.message_id = m.id
        ),
        '[]'
      ) AS mentioned_user_ids
    FROM messages m
    INNER JOIN users u ON u.id = m.sender_id
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.room_id = $1
  `;
  const params = [roomId];

  if (before) {
    // Compound cursor "<created_at>|<id>". A bare created_at comparison skips
    // rows when two messages share a timestamp, because `created_at < cursor`
    // drops every row equal to the cursor — including the one we just returned
    // and any that followed it (BACKEND_TASKS.md Bug 15). The id breaks the tie.
    // A cursor without the separator is still accepted for older clients.
    const sep = before.indexOf('|');
    if (sep === -1) {
      params.push(before);
      sql += ` AND m.created_at < $${params.length}`;
    } else {
      params.push(before.slice(0, sep), before.slice(sep + 1));
      sql += ` AND (m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
  }

  sql += `
    GROUP BY m.id, m.room_id, m.sender_id, u.display_name, u.avatar_url,
             m.content, m.reply_to_id, m.edited_at, m.deleted_at, m.created_at
    ORDER BY m.created_at DESC, m.id DESC LIMIT $${params.length + 1}`;
  params.push(PAGE_SIZE);

  const result = await query(sql, params);

  // 3. Attach reactions, then return with the cursor for the next page.
  //    One extra query for the whole page, not one per message.
  const messages = await attachReactions(result.rows, req.user.id);
  const last = messages[messages.length - 1];
  const nextCursor =
    messages.length === PAGE_SIZE && last ? `${last.created_at}|${last.id}` : null;

  return ok(res, { messages, nextCursor });
});

/**
 * Load one message in the same shape listMessages returns, with sender metadata
 * and reactions resolved.
 *
 * The edit/delete/reaction endpoints re-read through this rather than returning
 * the UPDATE ... RETURNING row, so all five surfaces hand the client one message
 * shape. Returning the raw updated row would have reintroduced exactly the drift
 * that Bug 6 describes, one endpoint at a time.
 */
async function getMessagePayload(messageId, viewerId) {
  const result = await query(
    `SELECT m.id, m.room_id, m.sender_id,
            u.display_name AS sender_name,
            u.avatar_url   AS sender_avatar,
            CASE WHEN m.deleted_at IS NOT NULL THEN NULL ELSE m.content END AS content,
            m.deleted_at IS NOT NULL AS is_deleted,
            m.reply_to_id,
            m.edited_at,
            m.deleted_at,
            m.created_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'id',        a.id,
                  'filename',  a.filename,
                  'size',      a.size_bytes,
                  'mime_type', a.file_type,
                  'url',       a.file_url
                )
              ) FILTER (WHERE a.id IS NOT NULL),
              '[]'
            ) AS attachments,
            COALESCE(
              (SELECT json_agg(mm.user_id)
                 FROM message_mentions mm
                WHERE mm.message_id = m.id),
              '[]'
            ) AS mentioned_user_ids
     FROM messages m
     INNER JOIN users u ON u.id = m.sender_id
     LEFT JOIN attachments a ON a.message_id = m.id
     WHERE m.id = $1
     GROUP BY m.id, m.room_id, m.sender_id, u.display_name, u.avatar_url,
              m.content, m.reply_to_id, m.edited_at, m.deleted_at, m.created_at`,
    [messageId],
  );

  if (result.rows.length === 0) {
    throw new ApiError(404, "Message not found");
  }

  const [message] = await attachReactions(result.rows, viewerId);
  return message;
}

// ---------- searchMessages ----------
// Full-text search across a room's messages using Postgres tsvector.
// Query: ?q=<search term>
const searchMessages = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const { q } = req.query;

  if (!q || !q.trim()) {
    throw new ApiError(400, "Search query (q) is required");
  }

  // 1. Verify the caller is a member of this room
  const membership = await query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, req.user.id],
  );
  if (membership.rows.length === 0) {
    throw new ApiError(403, "You are not a member of this room");
  }

  // 2. Full-text search with ts_rank for relevance ordering.
  //    Deleted messages are excluded outright: a search should never be able
  //    to surface content the author has retracted. The attachments agg
  //    mirrors listMessages so a hit on a file message still renders its
  //    file card (BACKEND_TASKS.md Bug 7 and the listMessages/searchMessages
  //    shape gap).
  //
  //    edited_at, deleted_at and is_deleted are selected here because they were
  //    NOT, while listMessages returned all three. So a search result and a
  //    history row were already two different message shapes, and the gap only
  //    became visible once edit and delete existed — a tombstone could not render
  //    from a search result because the field saying it was a tombstone was
  //    absent. Same shape-drift class as Bug 6, folded in here rather than left
  //    for someone to trip over.
  const result = await query(
    `SELECT
       m.id,
       m.room_id,
       m.sender_id,
       u.display_name AS sender_name,
       u.avatar_url   AS sender_avatar,
       m.content,
       m.reply_to_id,
       m.edited_at,
       m.deleted_at,
       m.deleted_at IS NOT NULL AS is_deleted,
       m.created_at,
       COALESCE(
         json_agg(
           json_build_object(
             'id',        a.id,
             'filename',  a.filename,
             'size',      a.size_bytes,
             'mime_type', a.file_type,
             'url',       a.file_url
           )
         ) FILTER (WHERE a.id IS NOT NULL),
         '[]'
       ) AS attachments,
       -- Same shape as listMessages, so search and history agree.
       COALESCE(
         (
           SELECT json_agg(mm.user_id)
           FROM message_mentions mm
           WHERE mm.message_id = m.id
         ),
         '[]'
       ) AS mentioned_user_ids,
       ts_rank(
         to_tsvector('english', m.content),
         plainto_tsquery('english', $2)
       ) AS rank
     FROM messages m
     INNER JOIN users u ON u.id = m.sender_id
     LEFT JOIN attachments a ON a.message_id = m.id
     WHERE m.room_id = $1
       AND m.deleted_at IS NULL
       AND to_tsvector('english', m.content) @@ plainto_tsquery('english', $2)
     GROUP BY m.id, m.room_id, m.sender_id, u.display_name, u.avatar_url,
              m.content, m.reply_to_id, m.edited_at, m.deleted_at, m.created_at
     ORDER BY rank DESC, m.created_at DESC
     LIMIT 50`,
    [roomId, q.trim()],
  );

  return ok(res, {
    messages: await attachReactions(result.rows, req.user.id),
    query: q.trim(),
  });
});


// ---------- editMessage ----------
// PATCH /messages/:id — author-only, no time limit. Replaces the body wholesale.
const editMessageHandler = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const { content } = req.body;
  const io = req.app.get("io");

  // `io` goes to the service first so the chat-list refresh happens at the
  // point of write. Re-read afterwards for the response.
  await editMessage({ messageId, userId: req.user.id, content, io });

  // Re-read the full row rather than trusting the UPDATE ... RETURNING, so the
  // response has exactly the shape listMessages returns — including sender
  // metadata and the resolved reactions. Emitting the whole message is what lets
  // a socket client replace its copy without a second request.
  const message = await getMessagePayload(messageId, req.user.id);

  if (io) {
    io.to(message.room_id).emit("message:updated", { message });
  }

  return ok(res, message);
});

// ---------- deleteMessage ----------
// DELETE /messages/:id — author or room admin. Soft delete; content is overwritten.
const deleteMessageHandler = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const io = req.app.get("io");

  const message = await deleteMessage({ messageId, userId: req.user.id, io });

  // Re-read for the full shape. The tombstone is what clients swap in, and it
  // carries is_deleted so the client knows to render one.
  const payload = await getMessagePayload(message.room_id && message.id, req.user.id);

  if (io) {
    io.to(payload.room_id).emit("message:deleted", { message: payload });
  }

  return ok(res, payload);
});

// ---------- addReaction ----------
// PUT /messages/:id/reactions — idempotent. Reacting twice does not stack.
const addReactionHandler = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const emoji = assertAllowedEmoji((req.body || {}).emoji);

  await addReaction({ messageId, userId: req.user.id, emoji });

  const message = await getMessagePayload(messageId, req.user.id);

  const io = req.app.get("io");
  if (io) {
    io.to(message.room_id).emit("message:reaction", { message });
  }

  return ok(res, message);
});

// ---------- removeReaction ----------
// DELETE /messages/:id/reactions/:emoji — removes the caller's own reaction.
const removeReactionHandler = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  // The emoji arrives percent-encoded in the path, and it is a multi-byte
  // character — so it must be decoded before the allowlist comparison, or a
  // legitimate 👍 fails the check as "%F0%9F%91%8D".
  const emoji = assertAllowedEmoji(decodeURIComponent(req.params.emoji));

  await removeReaction({ messageId, userId: req.user.id, emoji });

  const message = await getMessagePayload(messageId, req.user.id);

  const io = req.app.get("io");
  if (io) {
    io.to(message.room_id).emit("message:reaction", { message });
  }

  return ok(res, message);
});

module.exports = {
  sendMessage,
  listMessages,
  searchMessages,
  editMessage: editMessageHandler,
  deleteMessage: deleteMessageHandler,
  addReaction: addReactionHandler,
  removeReaction: removeReactionHandler,
};
