const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { query } = require('../config/db');
const { createMessage } = require('../services/message.service');
const { personalRoom } = require('../services/notification.service');
const presence = require('../services/presence.service');
const socketHandler = require('../utils/socketHandler');

// Event names match what was scoped in the original planning conversation.
//
// Client -> Server:
//   join-room        { roomId }
//   leave-room       { roomId }
//   send-message     { roomId, content, replyToId?, attachments?,
//                      mentionedUserIds? }
//   typing            { roomId }
//   stop-typing       { roomId }
//   message-read      { roomId, messageId }
//   heartbeat         {}              (keep-alive for presence)
//
// Server -> Client:
//   receive-message   { message }
//   chat:updated      { roomId, lastMessage, unreadCount }
//                                   emitted to EACH MEMBER'S personal room
//                                   (user:<id>), never the chat room, because
//                                   unreadCount is one person's number. Fires
//                                   after every message create, edit and
//                                   delete, so a sidebar row — preview and
//                                   badge — updates without being opened.
//                                   Emitted by emitChatUpdated in
//                                   services/notification.service.js.
//   user-online        { userId }
//   user-offline       { userId }
//   room-presence      { roomId, onlineUserIds }
//   room-typing        { roomId, typingUserIds }
//   typing             { roomId, userId }
//   stop-typing        { roomId, userId }
//   message-read       { roomId, messageId, userId, lastSeenAt }
//                                   persists: advances room_members.last_seen_at
//                                   and echoes the stored timestamp back, so the
//                                   reader's own client adopts the server's value
//                                   rather than guessing one.
//   room-seen          { roomId, userId, lastSeenAt }
//                                   emitted by PATCH /rooms/:roomId/seen, which
//                                   is the other writer of last_seen_at. Both
//                                   writers publish, so a read tick updates for
//                                   everyone whether the reader arrived via the
//                                   socket or the REST call.
//   decision:pinned    { decision, scope, userId }
//   decision:unpinned  { decision, scope, userId }
//                                   from PUT /decisions/:decisionId/pin and
//                                   DELETE .../pin/:scope. The decision carries
//                                   pins.room, which is shared truth and identical
//                                   for every viewer. It does NOT carry a finished
//                                   pins.mine — that is per viewer, the same way
//                                   reactions' `reacted` is, so each client fixes
//                                   up its own from the acting userId.
//   task:updated       { task }     emitted by POST /tasks and
//                                   PATCH /tasks/:taskId/status
//   message:updated    { message }  the whole edited row, from
//                                   PATCH /messages/:messageId
//   message:deleted    { message }  the whole tombstone row, from
//                                   DELETE /messages/:messageId
//   message:reaction   { message }  the whole row with reactions recomputed,
//                                   from PUT/DELETE .../reactions. A reaction by
//                                   anyone changes `reacted` for the viewer, so
//                                   the message is re-read per change rather than
//                                   a delta being pushed.
//   notification       { notification }  a full row; clients append it to their
//                                   list directly, so it is never a bare count
//   notification:seen  { updated }  how many rows the caller just marked seen,
//                                   for the same user's OTHER tabs
//   error:message      { message }   (see note below)
//
// Rooms the server joins for you, without the client asking:
//   user:{userId}     every socket joins its own on connect. This is the
//                      delivery target for per-user events such as
//                      `notification`, which are addressed to one person rather
//                      than to a chat room.
//
// Not yet implemented, so deliberately absent from this list rather than
// advertised and never sent (BACKEND_TASKS.md Bug 13): upload-progress and
// decision:created. `notification` is live — emitted by notification.service for
// room invites and mentions. Marking notifications seen emits the separate
// `notification:seen`, never `notification` with a count in place of a row.
//
// Limitation worth knowing: task:updated is emitted to the task's room, and
// sockets only join a room on demand (client/src/hooks/useMessages.js emits
// join-room when a room view mounts). A user sitting on the top-level cross-room
// Tasks page has not joined the rooms it lists, so that page will not update
// live — only on reload.

// Membership check for events that only relay state. createMessage already
// authorises send-message; these three did not, so a client could spoof read
// receipts and typing indicators into rooms it does not belong to.
async function isMember(roomId, userId) {
  const result = await query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId],
  );
  return result.rows.length > 0;
}

function registerSocketHandlers(io) {
  // Auth: client connects with `io(url, { auth: { token } })`.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Missing auth token'));

    let payload;
    try {
      payload = jwt.verify(token, env.jwt.accessSecret);
    } catch (err) {
      return next(new Error('Invalid or expired token'));
    }

    // Same soft-delete check requireAuth does on the REST side. A self-contained
    // JWT cannot be revoked, so without this a deleted account kept an open
    // socket and could still send messages until its token expired. Checked once
    // at connect rather than per event, which bounds the window to the lifetime
    // of the connection rather than a single request.
    try {
      const result = await query(
        `SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [payload.sub],
      );
      if (result.rows.length === 0) {
        return next(new Error('This account has been deleted'));
      }
    } catch (err) {
      return next(new Error('Could not verify account'));
    }

    socket.user = { id: payload.sub, email: payload.email };
    return next();
  });

  io.on('connection', (socket) => {
    const { id: userId } = socket.user;
    const onEvent = (event, handler) => socket.on(event, socketHandler(socket, async (...args) => {
      const initialized = await ready;
      if (event !== 'disconnect' && (!initialized || !socket.connected)) return;
      return handler(...args);
    }, {
      payload: !['heartbeat', 'disconnect'].includes(event),
    }));

    // --- Presence: mark user online + start heartbeat ---
    // Only announce user-online for the user's first socket; a second tab
    // joining should not re-announce someone already online.
    // Register listeners synchronously. Clients can emit join-room immediately
    // after connecting, before these Redis calls finish.
    const ready = (async () => {
      try {
        const openSockets = await presence.socketConnected(userId, socket.id);
        await presence.userConnected(userId);
        if (socket.connected && openSockets === 1) socket.broadcast.emit('user-online', { userId });
        return true;
      } catch (error) {
        console.error('Could not initialize socket presence', error);
        socket.disconnect(true);
        return false;
      }
    })();

    // Join a per-user room so events addressed to one person (notifications)
    // can reach every tab they have open. Chat rooms are joined by raw room
    // UUID via join-room, so this prefixed name cannot collide with one.
    socket.join(personalRoom(userId));

    // --- join-room: verify membership, track per-room presence ---
    onEvent('join-room', async ({ roomId }) => {
      if (!roomId) return;

      // Verify the user is actually a member of this room
      const result = await query(
        `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
        [roomId, userId],
      );

      if (result.rows.length === 0) {
        socket.emit('error:message', { message: 'You are not a member of this room' });
        return;
      }

      socket.join(roomId);

      // Track per-room presence and broadcast updated list
      await presence.userJoinedRoom(userId, roomId);
      const roomOnlineUsers = await presence.getRoomOnlineUsers(roomId);
      io.to(roomId).emit('room-presence', {
        roomId,
        onlineUserIds: roomOnlineUsers,
      });

      // Send the new joiner the current typing state for this room
      const typingUserIds = await presence.getTypingUsers(roomId);
      socket.emit('room-typing', { roomId, typingUserIds });
    });

    onEvent('leave-room', async ({ roomId }) => {
      if (!roomId) return;

      socket.leave(roomId);
      // Stamp last_seen_at before leaving so the digest window closes when
      // the user actually goes away (BACKEND_TASKS.md Bug 2).
      await query(
        `UPDATE room_members SET last_seen_at = NOW() WHERE room_id = $1 AND user_id = $2`,
        [roomId, userId],
      );
      await presence.userLeftRoom(userId, roomId);
      const roomOnlineUsers = await presence.getRoomOnlineUsers(roomId);
      io.to(roomId).emit('room-presence', {
        roomId,
        onlineUserIds: roomOnlineUsers,
      });
    });

    // --- send-message: persist to DB, then broadcast the saved row ---
    // mentionedUserIds is how a client says who was mentioned. Optional for now:
    // omitting it falls back to matching display names in the text, which is
    // temporary — see resolveMentionIds in services/message.service.js.
    onEvent('send-message', async ({ roomId, content, replyToId, attachments, mentionedUserIds }) => {
      const message = await createMessage({
        roomId,
        senderId: userId,
        content,
        replyToId,
        attachments,
        mentionedUserIds,
        io,
      });

      // Auto-clear typing indicator when a message is sent
      await presence.clearTyping(roomId, userId);
      socket.to(roomId).emit('stop-typing', { roomId, userId });

      io.to(roomId).emit('receive-message', { message });
    });

    // --- typing indicators: Redis-backed with auto-expiry ---
    onEvent('typing', async ({ roomId }) => {
      if (!roomId) return;
      if (!(await isMember(roomId, userId))) return;
      await presence.setTyping(roomId, userId);
      socket.to(roomId).emit('typing', { roomId, userId });
    });

    onEvent('stop-typing', async ({ roomId }) => {
      if (!roomId) return;
      if (!(await isMember(roomId, userId))) return;
      await presence.clearTyping(roomId, userId);
      socket.to(roomId).emit('stop-typing', { roomId, userId });
    });

    // --- message-read: advance the reader's pointer, then broadcast ---
    // Membership is checked because this previously relayed to any roomId the
    // client named, letting a user spoof read receipts into rooms they are not
    // in.
    //
    // It now PERSISTS, which is the whole point. Before this, the socket
    // broadcast and room_members.last_seen_at were two competing notions of
    // "read": the event evaporated the moment the recipient's tab closed, while
    // the durable pointer that unread_count and the digest filter against was
    // only ever moved by PATCH /rooms/:roomId/seen. A read tick that vanishes
    // on reload is not a receipt, it is a rumour. Both paths now write the same
    // column, so there is one definition of read and it survives a restart.
    //
    // last_seen_at advances to NOW(), not to the read message's created_at:
    // reading a room means reading everything up to the point you reached, and
    // the newest message is a safe upper bound for what the reader has seen.
    onEvent('message-read', async ({ roomId, messageId }) => {
      if (!roomId || !messageId) return;
      if (!(await isMember(roomId, userId))) return;

      const result = await query(
        `UPDATE room_members
            SET last_seen_at = NOW()
          WHERE room_id = $1 AND user_id = $2
          RETURNING last_seen_at`,
        [roomId, userId],
      );
      const lastSeenAt = result.rows[0]?.last_seen_at;

      // Broadcast to the room including the sender, so the reader's own client
      // converges on the same timestamp the server stored rather than assuming
      // one. `.to()` would exclude them and leave their tick on a guess.
      io.to(roomId).emit('message-read', { roomId, messageId, userId, lastSeenAt });
    });

    // --- heartbeat: refresh the user's presence TTL ---
    onEvent('heartbeat', async () => {
      await presence.refreshHeartbeat(userId);
    });

    // --- disconnect: clean up all presence state ---
    onEvent('disconnect', async () => {
      // If the user still has another tab open, they are not offline — do not
      // tear down their presence or announce them as gone.
      const remainingSockets = await presence.socketDisconnected(userId, socket.id);
      if (remainingSockets > 0) return;

      // Remove from global online set + heartbeat key
      await presence.userDisconnected(userId);

      // Remove from all per-room presence sets
      const leftRooms = await presence.cleanupUserFromRooms(userId);

      // Notify each room the user was in
      for (const roomId of leftRooms) {
        const roomOnlineUsers = await presence.getRoomOnlineUsers(roomId);
        io.to(roomId).emit('room-presence', {
          roomId,
          onlineUserIds: roomOnlineUsers,
        });
      }

      // Clean up any active typing indicators
      await presence.cleanupUserTyping(userId);

      // Broadcast global offline
      socket.broadcast.emit('user-offline', { userId });
    });
  });

  // --- Start the heartbeat sweep timer ---
  // Periodically removes users from online_users whose heartbeat has expired
  // (network drop without clean disconnect).
  presence.startHeartbeatSweep(io);
}

module.exports = registerSocketHandlers;
