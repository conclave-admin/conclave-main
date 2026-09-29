const { query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const ApiError = require("../utils/ApiError");
const { createMessage } = require("../services/message.service");

const PAGE_SIZE = 50;

// ---------- sendMessage ----------
// REST fallback for sending a message — the primary path is the
// send-message Socket.IO event (see src/sockets/index.js). Both
// write through message.service.createMessage so history stays consistent.
const sendMessage = asyncHandler(async (req, res) => {
  const { roomId } = req.body;
  const { content, replyToId, attachments } = req.body;

  if (!roomId) {
    throw new ApiError(400, "roomId is required");
  }

  const message = await createMessage({
    roomId,
    senderId: req.user.id,
    content,
    replyToId,
    attachments,
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
      ) AS attachments
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

  // 3. Return with cursor for the next page
  const messages = result.rows;
  const last = messages[messages.length - 1];
  const nextCursor =
    messages.length === PAGE_SIZE && last ? `${last.created_at}|${last.id}` : null;

  return ok(res, { messages, nextCursor });
});

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
  const result = await query(
    `SELECT
       m.id,
       m.room_id,
       m.sender_id,
       u.display_name AS sender_name,
       u.avatar_url   AS sender_avatar,
       m.content,
       m.reply_to_id,
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
              m.content, m.reply_to_id, m.created_at
     ORDER BY rank DESC, m.created_at DESC
     LIMIT 50`,
    [roomId, q.trim()],
  );

  return ok(res, { messages: result.rows, query: q.trim() });
});

module.exports = { sendMessage, listMessages, searchMessages };
