const { parseMediaPage, mediaCursor, UUID } = require('../utils/mediaPagination');
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
const { attachPins: attachMessagePins, pinMessage, unpinMessage, listRoomPins } = require("../services/messagePin.service");
const { attachPolls } = require("../services/poll.service");
const { attachReceiptSummaries } = require("../services/messageReceipt.service");
const attachPollsAndReceipts = async rows => attachReceiptSummaries(await attachPolls(rows));

const PAGE_SIZE = 50;

// ---------- sendMessage ----------
// REST fallback for sending a message — the primary path is the
// send-message Socket.IO event (see src/sockets/index.js). Both
// write through message.service.createMessage so history stays consistent.
const sendMessage = asyncHandler(async (req, res) => {
  const { roomId } = req.body;
  const { content, replyToId, attachments, albumId, mentionedUserIds, clientId, forwardSource } = req.body;

  if (!roomId) {
    throw new ApiError(400, "roomId is required");
  }

  const message = await createMessage({
    roomId,
    senderId: req.user.id,
    clientId,
    content,
    replyToId,
    attachments,
    albumId,
    mentionedUserIds,
    forwardSource,
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
  const { before, afterSeq } = req.query;

  if(req.query.ids!==undefined){
    const ids=typeof req.query.ids==='string'?req.query.ids.split(','):[];
    if(!ids.length||ids.length>200||ids.some(id=>!UUID.test(id))||before!==undefined||afterSeq!==undefined||req.query.around!==undefined)throw new ApiError(400,'Provide 1–200 message IDs without another cursor');
    return ok(res,await require('../services/messageSnapshot.service').snapshots(roomId,req.user.id,ids));
  }

  // 1. Verify the caller is a member of this room
  const membership = await query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, req.user.id],
  );
  if (membership.rows.length === 0) {
    throw new ApiError(403, "You are not a member of this room");
  }

  let anchorSequence = null;
  if (req.query.around !== undefined) {
    if (typeof req.query.around !== 'string' || !UUID.test(req.query.around) || before !== undefined || afterSeq !== undefined) throw new ApiError(400, 'around must identify one message without another history cursor');
    const anchor = await query('SELECT room_sequence FROM messages WHERE id = $1 AND room_id = $2 AND deleted_at IS NULL', [req.query.around, roomId]);
    if (!anchor.rows.length) throw new ApiError(404, 'Message no longer available');
    anchorSequence = anchor.rows[0].room_sequence;
  }

  // 2. Fetch messages — cursor-based pagination via created_at
  let sql = `
    SELECT
      m.id,
      m.state_version,
      m.client_id,
      m.album_id,
      m.forwarded,
      m.room_sequence,
      m.room_id,
      m.sender_id,
      u.profile_version AS sender_profile_version,u.display_name AS sender_name,
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
            'url',       a.file_url,
            'width',     a.width,
            'height',    a.height,
            'preview_url', a.preview_url,
            'duration', a.duration
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

  if (anchorSequence !== null) {
    params.push(anchorSequence);
    sql += ` AND m.room_sequence <= $${params.length}`;
  } else if (afterSeq !== undefined) {
    const seq = Number(afterSeq);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new ApiError(400, 'afterSeq must be a non-negative integer');
    params.push(seq);
    sql += ` AND m.room_sequence > $${params.length}`;
  } else if (before) {
    // Compound cursor "<created_at>|<id>". A bare created_at comparison skips
    // rows when two messages share a timestamp, because `created_at < cursor`
    // drops every row equal to the cursor — including the one we just returned
    // and any that followed it (BACKEND_TASKS.md Bug 15). The id breaks the tie.
    // A cursor without the separator is still accepted for older clients.
    const sep = before.indexOf('|');
    if (sep === -1) {
      if (/^\d+$/.test(before)) {
        params.push(before);
        sql += ` AND m.room_sequence < $${params.length}`;
      } else {
      params.push(before);
      sql += ` AND m.created_at < $${params.length}`;
      }
    } else {
      const seq = before.slice(0, sep);
      if (/^\d+$/.test(seq)) {
        params.push(seq);
        sql += ` AND m.room_sequence < $${params.length}`;
      } else {
        params.push(before.slice(0, sep), before.slice(sep + 1));
        sql += ` AND (m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
    }
  }

  const ascending = afterSeq !== undefined;
  sql += `
    GROUP BY m.id, m.room_id, m.sender_id, u.profile_version, u.display_name, u.avatar_url,
             m.client_id, m.album_id, m.forwarded, m.room_sequence, m.content, m.reply_to_id, m.edited_at, m.deleted_at, m.created_at
    ORDER BY m.room_sequence ${ascending ? 'ASC' : 'DESC'} LIMIT $${params.length + 1}`;
  params.push(ascending ? 200 : PAGE_SIZE);

  const result = await query(sql, params);

  // 3. Attach reactions, then return with the cursor for the next page.
  //    One extra query for the whole page, not one per message.
  const messages = await attachPollsAndReceipts(
    await attachMessagePins(
      await attachReactions(result.rows, req.user.id),
      req.user.id,
    ),
  );
  const last = messages[messages.length - 1];
  // ISO rather than String(date): a Date interpolated into a template is
  // rendered through toString(), which drops milliseconds and emits the local
  // timezone name ("Tue Oct 13 2026 ... (West Africa Standard Time)"). The
  // reader casts it back with ::timestamptz and a parser that never sees that
  // format cannot recover the lost milliseconds, so a page boundary landing
  // inside the same second skipped or repeated rows. Decisions already send
  // ISO for the same reason.
  const nextCursor =
    messages.length === PAGE_SIZE && last
      ? String(last.room_sequence)
      : null;

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
async function getMessagePayload(messageId,viewerId){
  const found=await query('SELECT room_id FROM messages WHERE id=$1',[messageId]);
  if(!found.rows.length)throw new ApiError(404,'Message not found');
  const result=await require('../services/messageSnapshot.service').snapshots(found.rows[0].room_id,viewerId,[messageId]);
  if(!result.messages.length)throw new ApiError(404,'Message not found');
  return result.messages[0];
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
      m.state_version,
       m.room_id,
       m.sender_id,
       m.client_id,
       m.album_id,
      m.forwarded,
       m.room_sequence,
       u.profile_version AS sender_profile_version,u.display_name AS sender_name,
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
             'url',       a.file_url,
             'width',     a.width,
             'height',    a.height,
             'preview_url', a.preview_url,
             'duration', a.duration
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
     GROUP BY m.id, m.room_id, m.sender_id, m.client_id, m.room_sequence, u.profile_version, u.display_name, u.avatar_url,
              m.album_id,
      m.forwarded, m.content, m.reply_to_id, m.edited_at, m.deleted_at, m.created_at
     ORDER BY rank DESC, m.created_at DESC
     LIMIT 50`,
    [roomId, q.trim()],
  );

  return ok(res, {
    messages: await attachPollsAndReceipts(
      await attachMessagePins(
        await attachReactions(result.rows, req.user.id),
        req.user.id,
      ),
    ),
    query: q.trim(),
  });
});


// ---------- editMessage ----------
// PATCH /messages/:id — author-only, no time limit. Replaces the body wholesale.
const editMessageHandler = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const { content } = req.body;
  const io = req.app.get("io");

  // A poll's question IS its message content. Editing it would mean the votes
  // recorded underneath now answer different words, so the option is removed
  // rather than hidden — clients hide Edit on a poll too.
  const poll = await query(`SELECT 1 FROM polls WHERE message_id = $1`, [messageId]);
  if (poll.rows.length > 0) throw new ApiError(400, "A poll cannot be edited");

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



// ---------- pinMessage / unpinMessage / listPinnedMessages ----------
// Three routes over the same service decisionPin.service uses for decisions.
//
// Authorisation lives in the service rather than the handler because both
// scopes need the same two facts — "are you in this message's room" and "are
// you the pinner or an admin" — and duplicating them here is how the decision
// and message versions of this rule drift apart.
//
// Removing an absent pin answers 200 with `unpinned: false` rather than 404,
// matching removeReaction and unpinDecision: a retried request is not a failure.

// PUT /messages/:messageId/pin   { scope }
const pinMessageHandler = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const message = await pinMessage({
    messageId,
    userId: req.user.id,
    scope: req.body?.scope,
    io: req.app.get('io'),
  });
  return ok(res, message);
});

// DELETE /messages/:messageId/pin/:scope
const unpinMessageHandler = asyncHandler(async (req, res) => {
  const { messageId, scope } = req.params;
  const message = await unpinMessage({
    messageId,
    userId: req.user.id,
    scope,
    io: req.app.get('io'),
  });
  return ok(res, message || { id: messageId, pins: { room: null, mine: [] }, unpinned: false });
});

// GET /messages/room/:roomId/pinned
//
// Membership is checked here rather than in the service, because this is the
// one path that can name a room without a message to attach it to.
const listPinnedMessages = asyncHandler(async (req, res) => {
  const { roomId } = req.params;

  const membership = await query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, req.user.id],
  );
  if (membership.rows.length === 0) {
    // 403 rather than 404 here: the room id is the caller's to know, they only
    // asked for a room they are not in. This is the same answer getRoomDigest
    // gives, and the opposite of getDecision's — see the note there.
    throw new ApiError(403, 'You are not a member of this room');
  }

  return ok(res, { messages: await listRoomPins(roomId, req.user.id) });
});

const listRoomMedia = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const membership = await query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, req.user.id]);
  if (!membership.rows.length) throw new ApiError(404, 'Room not found');
  const { kind, limit, after, cursor } = parseMediaPage(req.query, roomId);
  const filters = {
    media: "(a.file_type LIKE 'image/%' OR a.file_type LIKE 'video/%')",
    audio: "a.file_type LIKE 'audio/%'",
    documents: "(COALESCE(a.file_type, '') NOT LIKE 'image/%' AND COALESCE(a.file_type, '') NOT LIKE 'video/%' AND COALESCE(a.file_type, '') NOT LIKE 'audio/%')",
  };
  const params = [roomId];
  let bounds = '';
  if (after) { params.push(after); bounds += ` AND m.created_at > $${params.length}::timestamptz`; }
  if (cursor) { params.push(cursor.sequence, cursor.id); bounds += ` AND (m.room_sequence, a.id) < ($${params.length - 1}::bigint, $${params.length}::uuid)`; }
  params.push(limit + 1);
  const result = await query(
    `SELECT a.id, a.filename, a.size_bytes AS size, a.file_type AS mime_type,
            a.file_url AS url, a.width, a.height, a.preview_url, a.duration,
            m.id AS message_id, m.created_at, m.room_sequence,
            m.sender_id, u.display_name AS sender_name
       FROM messages m
       INNER JOIN attachments a ON a.message_id = m.id
       INNER JOIN users u ON u.id = m.sender_id
      WHERE m.room_id = $1 AND m.deleted_at IS NULL AND m.room_sequence IS NOT NULL AND ${filters[kind]} ${bounds}
      ORDER BY m.room_sequence DESC, a.id DESC LIMIT $${params.length}`, params,
  );
  const hasMore = result.rows.length > limit;
  const media = result.rows.slice(0, limit);
  return ok(res, { media, nextCursor: hasMore ? mediaCursor(media[media.length - 1], roomId, kind, after) : null });
});

module.exports = { sendMessage, listMessages, searchMessages, editMessage: editMessageHandler, deleteMessage: deleteMessageHandler, addReaction: addReactionHandler, removeReaction: removeReactionHandler, pinMessageHandler, unpinMessageHandler, listPinnedMessages, listRoomMedia };

module.exports.getMessageReceipts = asyncHandler(async (req, res) => ok(res, await require('../services/messageReceipt.service').details(req.params.messageId, req.user.id)));

module.exports.getRoomReceiptSummaries = asyncHandler(async (req, res) => {
  const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',') : [];
  if (!ids.length || ids.length > 200 || ids.some(id => !UUID.test(id))) throw new ApiError(400, 'Provide up to 200 message IDs');
  const receipts = await require('../services/realtimeAccess.service').withRoomMembership(req.params.roomId, req.user.id, async db => {
    const rows = await db.query('SELECT id FROM messages WHERE room_id=$1 AND id=ANY($2::uuid[])', [req.params.roomId, ids]);
    return (await attachReceiptSummaries(rows.rows, db)).map(m => ({ messageId: m.id, receipt_summary: m.receipt_summary }));
  });
  return ok(res, { roomId: req.params.roomId, receipts });
});
