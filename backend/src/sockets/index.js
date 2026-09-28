const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { query } = require('../config/db');
const { createMessage } = require('../services/message.service');
const presence = require('../services/presence.service');

// Event names match what was scoped in the original planning conversation,
// plus two new events for the differentiator features (decision:created,
// task:updated) so room UIs can update live without polling.
//
// Client -> Server:
//   join-room        { roomId }
//   leave-room       { roomId }
//   send-message     { roomId, content, replyToId? }
//   typing            { roomId }
//   stop-typing       { roomId }
//   message-read      { roomId, messageId }
//   heartbeat         {}              (new — keep-alive for presence)
//
// Server -> Client:
//   receive-message   { message }
//   user-online        { userId }
//   user-offline       { userId }
//   notification        { notification }
//   upload-progress      { messageId, percent }
//   room-typing          { roomId, typingUserIds }  (new — full typing state on join)
//   decision:created       { decision }   (new — Decisions Layer)
//   task:updated             { task }       (new — Action Items)

function registerSocketHandlers(io) {
  // Auth: client connects with `io(url, { auth: { token } })`.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Missing auth token'));
    try {
      const payload = jwt.verify(token, env.jwt.accessSecret);
      socket.user = { id: payload.sub, email: payload.email };
      return next();
    } catch (err) {
      return next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', async (socket) => {
    const { id: userId } = socket.user;

    // --- Presence: mark user online + start heartbeat ---
    await presence.userConnected(userId);
    socket.broadcast.emit('user-online', { userId });

    // --- join-room: verify membership, track per-room presence ---
    socket.on('join-room', async ({ roomId }) => {
      if (!roomId) return;

      // Verify the user is actually a member of this room
      const result = await query(
        `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
        [roomId, userId],
      );

      if (result.rows.length === 0) {
        socket.emit('error', { message: 'You are not a member of this room' });
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

    socket.on('leave-room', async ({ roomId }) => {
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
    socket.on('send-message', async ({ roomId, content, replyToId, attachments }) => {
      try {
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
      } catch (err) {
        socket.emit('error', {
          message: err.message || 'Failed to send message',
        });
      }
    });

    // --- typing indicators: Redis-backed with auto-expiry ---
    socket.on('typing', async ({ roomId }) => {
      if (!roomId) return;
      await presence.setTyping(roomId, userId);
      socket.to(roomId).emit('typing', { roomId, userId });
    });

    socket.on('stop-typing', async ({ roomId }) => {
      if (!roomId) return;
      await presence.clearTyping(roomId, userId);
      socket.to(roomId).emit('stop-typing', { roomId, userId });
    });

    // --- message-read: broadcast read receipt to the room ---
    socket.on('message-read', async ({ roomId, messageId }) => {
      socket.to(roomId).emit('message-read', { roomId, messageId, userId });
    });

    // --- heartbeat: refresh the user's presence TTL ---
    socket.on('heartbeat', async () => {
      await presence.refreshHeartbeat(userId);
    });

    // --- disconnect: clean up all presence state ---
    socket.on('disconnect', async () => {
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
