const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { query } = require('../config/db');
const { createMessage } = require('../services/message.service');
const presence = require('../services/presence.service');
const socketHandler = require('../utils/socketHandler');

// Event names match what was scoped in the original planning conversation.
//
// Client -> Server:
//   join-room        { roomId }
//   leave-room       { roomId }
//   send-message     { roomId, content, replyToId?, attachments? }
//   typing            { roomId }
//   stop-typing       { roomId }
//   message-read      { roomId, messageId }
//   heartbeat         {}              (keep-alive for presence)
//
// Server -> Client:
//   receive-message   { message }
//   user-online        { userId }
//   user-offline       { userId }
//   room-presence      { roomId, onlineUserIds }
//   room-typing        { roomId, typingUserIds }
//   typing             { roomId, userId }
//   stop-typing        { roomId, userId }
//   message-read       { roomId, messageId, userId }
//   task:created       { task }     (REST task creation, to room subscribers)
//   task:updated       { task }     (REST status change, to room subscribers)
//   error:message      { message }   (see note below)
//
// Not yet implemented, so deliberately absent from this list rather than
// advertised and never sent (BACKEND_TASKS.md Bug 13): notification,
// upload-progress and decision:created are not yet emitted.

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
    onEvent('send-message', async ({ roomId, content, replyToId, attachments }) => {
      const message = await createMessage({
        roomId,
        senderId: userId,
        content,
        replyToId,
        attachments,
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

    // --- message-read: broadcast read receipt to the room ---
    // Membership is checked because this previously relayed to any roomId the
    // client named, letting a user spoof read receipts into rooms they are not
    // in. It still only broadcasts; nothing is persisted (see BACKEND_TASKS.md
    // item I for a real read-receipt store).
    onEvent('message-read', async ({ roomId, messageId }) => {
      if (!roomId || !messageId) return;
      if (!(await isMember(roomId, userId))) return;
      socket.to(roomId).emit('message-read', { roomId, messageId, userId });
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
