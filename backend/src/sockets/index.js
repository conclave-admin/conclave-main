const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { query } = require("../config/db");
const { createMessage } = require("../services/message.service");
const { personalRoom } = require("../services/notification.service");
const presence = require("../services/presence.service");
const conversationActivity = require("../services/conversationActivity.service");
const ACTIVITY_ORDER = Symbol("activityOrder");
const indicatorEvents = new Set([
  "typing",
  "stop-typing",
  "start-recording",
  "stop-recording",
]);
const { redisClient } = require("../config/redis");
const socketHandler = require("../utils/socketHandler");
const rateLimit = require("../middlewares/rateLimit.middleware");
const ApiError = require("../utils/ApiError");
const { requireSession, sessionRoom } = require("../services/session.service");
const {
  registerAccessControl,
  withRoomMembership,
} = require("../services/realtimeAccess.service");

// Event names match what was scoped in the original planning conversation.
//
// Client -> Server:
//   join-room        { roomId }
//   leave-room       { roomId }
//   send-message     { roomId, content, replyToId?, attachments?,
//                      mentionedUserIds? }
//   typing            { roomId }
//   stop-typing       { roomId }
//   start-recording   { roomId }
//   stop-recording    { roomId }
//   message-read      { roomId, messageId }
//   heartbeat         { foreground?, roomId?, revision? }
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
// Global user presence is intentionally not broadcast. Presence is visible
// only to members currently subscribed to the same room.
//   room-presence      { roomId, available, onlineUserIds, viewingUserIds,
//                        typingUserIds, recordingUserIds, activity,
//                        activityVersion, hiddenUserIds, checkedAt }
//   presence:unavailable / presence:resync  invalidate or refresh presence
//   room-typing        same filtered activity fields as room-presence
//   typing / stop-typing / start-recording / stop-recording
//                      { roomId, userId, ttlMs, activityVersion }
//   privacy:changed    { userId, hidden }  sent to both affected users
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
//                                   PATCH /tasks/:taskId/status. Sent to each
//                                   of the assignee, the creator and the room's
//                                   admins individually in `user:{userId}`,
//                                   never to the room — the list query hides a
//                                   task from everyone else, so announcing it
//                                   would leak it.
//   poll:updated       { messageId, roomId, poll }
//                                   from PUT /polls/:pollId/vote and POST
//                                   /polls/:pollId/close. Carries ONLY the
//                                   poll, never the whole message: a message
//                                   payload holds per-viewer fields
//                                   (reactions' `reacted`, `pins.mine`), and
//                                   replacing one wholesale would overwrite
//                                   those on everyone else's screen. The poll
//                                   itself is viewer-independent — who voted is
//                                   shared truth.
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
// Limitation worth knowing, now half-fixed: task:updated is no longer emitted to
// the task's room (see its entry above), so it reaches the assignee, the creator
// and the admins on `user:{userId}` — which every socket joins on connect, and so
// the cross-room Tasks page updates live even though it never joins a room.
// Nothing else here has changed: sockets still join a chat room only on demand
// (client/src/hooks/useMessages.js emits join-room when a room view mounts).

function registerSocketHandlers(io) {
  registerAccessControl(io);
  io.use(async (socket, next) => {
    const reject = (message, code) => {
      const error = new Error(message);
      error.data = { code };
      return next(error);
    };
    const token = socket.handshake.auth?.token;
    if (!token) return reject("Missing auth token", "AUTH_INVALID");
    let payload;
    try {
      payload = jwt.verify(token, env.jwt.accessSecret);
    } catch (error) {
      return reject(
        "Invalid or expired token",
        error.name === "TokenExpiredError" ? "ACCESS_EXPIRED" : "AUTH_INVALID",
      );
    }
    if (!Number.isFinite(payload.exp))
      return reject("Access token must expire", "AUTH_INVALID");
    try {
      const session = await requireSession(payload);
      socket.user = { id: payload.sub, email: payload.email };
      socket.authClaims = {
        sub: payload.sub,
        sid: payload.sid,
        exp: payload.exp,
      };
      socket.sessionExpiresAt = Math.min(
        payload.exp * 1000,
        new Date(session.expires_at).getTime(),
      );
      socket.data.sessionId = payload.sid;
      socket.data.userId = payload.sub;
    } catch (error) {
      return reject(
        error.status === 401 ? error.message : "Could not verify account",
        error.status === 401 ? "SESSION_REVOKED" : "AUTH_UNAVAILABLE",
      );
    }
    return next();
  });

  io.on("connection", (socket) => {
    const { id: userId } = socket.user;
    socket.data.activity = { foreground: false, roomId: null, revision: -1 };
    let activityWork = Promise.resolve();
    let indicatorOrder = 0;
    const onEvent = (event, handler) => {
      const run = socketHandler(
        socket,
        async (...args) => {
          const initialized = await ready;
          if (event !== "disconnect") {
            if (!initialized || !socket.connected) return;
            if (Date.now() >= socket.sessionExpiresAt) {
              socket.emit("session:expired", {
                sessionId: socket.data.sessionId,
              });
              socket.disconnect(true);
              throw new ApiError(401, "Access token expired");
            }
            if (indicatorEvents.has(event)) {
              if (
                !rateLimit.consume(`indicators:${socket.id}`, {
                  windowMs: 10000,
                  max: 24,
                })
              )
                throw new ApiError(429, "Too many activity updates");
            }
            try {
              await requireSession(socket.authClaims);
            } catch (error) {
              if (error.status === 401) {
                socket.emit("session:revoked", {
                  sessionId: socket.data.sessionId,
                });
                socket.disconnect(true);
              }
              throw error;
            }
            // The session check is asynchronous; revocation may disconnect us while it runs.
            if (!socket.connected) return;
          }
          return handler(...args);
        },
        {
          payload: !["heartbeat", "disconnect"].includes(event),
        },
      );
      socket.on(event, (...args) => {
        if (event === "heartbeat") {
          if (typeof args[0] === "function") args.unshift({});
          else if (args[0] === undefined) args[0] = {};
        }
        if (args[0] && typeof args[0] === "object" && !Array.isArray(args[0]))
          args[0][ACTIVITY_ORDER] = ++indicatorOrder;
        const work = run(...args);
        if (event === "disconnect") presence.trackCleanup(work);
        return work;
      });
    };

    // --- Presence: mark user online + start heartbeat ---
    // A second tab joins independently. Presence is published only after it
    // joins a room, and room rosters account for every socket.
    // Register listeners synchronously. Clients can emit join-room immediately
    // after connecting, before these Redis calls finish.
    const ready = (async () => {
      try {
        await socket.join(personalRoom(userId));
        await socket.join(sessionRoom(socket.data.sessionId));
        await requireSession(socket.authClaims);
        if (!socket.connected) return false;
        await presence.socketConnected(userId, socket.id);
        await presence.publishUserPresence(io, userId);
        return true;
      } catch (error) {
        console.error("Could not initialize socket presence", error);
        socket.disconnect(true);
        return false;
      }
    })();

    // Join a per-user room so events addressed to one person (notifications)
    // can reach every tab they have open. Chat rooms are joined by raw room
    // UUID via join-room, so this prefixed name cannot collide with one.
    // Expiration disconnects even an idle socket; the client can refresh and
    // reconnect using the same still-active session.
    let expiryTimer;
    const scheduleExpiry = () => {
      expiryTimer = setTimeout(
        () => {
          if (Date.now() < socket.sessionExpiresAt) return scheduleExpiry();
          socket.emit("session:expired", { sessionId: socket.data.sessionId });
          socket.disconnect(true);
        },
        Math.max(1, Math.min(socket.sessionExpiresAt - Date.now(), 2147483647)),
      );
      expiryTimer.unref?.();
    };
    scheduleExpiry();

    // --- join-room: verify membership, track per-room presence ---
    onEvent("join-room", async ({ roomId }) => {
      if (!roomId) return;
      return withRoomMembership(roomId, userId, async (client) => {
        if (!socket.connected) return;
        await socket.join(roomId);
        await presence.userJoinedRoom(userId, roomId, socket.id);
        await presence.publishRoomPresence(io, roomId, client);
        return { roomId, joined: true };
      });
    });

    onEvent("leave-room", async ({ roomId, [ACTIVITY_ORDER]: order }) => {
      if (!roomId || !socket.rooms.has(roomId)) return;

      await socket.leave(roomId);
      await presence.userLeftRoom(userId, roomId, socket.id);
      if (socket.data.activity.roomId === roomId)
        socket.data.activity.roomId = null;
      await conversationActivity.clearDevice(roomId, userId, socket.id, order);
      await presence.publishRoomPresence(io, roomId, undefined, userId);
      return { roomId, left: true };
    });

    // --- send-message: persist to DB, then broadcast the saved row ---
    // mentionedUserIds is how a client says who was mentioned. Optional for now:
    // omitting it falls back to matching display names in the text, which is
    // temporary — see resolveMentionIds in services/message.service.js.
    onEvent(
      "send-message",
      async ({
        roomId,
        clientId,
        content,
        replyToId,
        attachments,
        albumId,
        mentionedUserIds,
        forwardSource,
        encryptedPayload,
        [ACTIVITY_ORDER]: order,
      }) => {
        if (!rateLimit.consume(`socket:${userId}:messages`, { max: 30 }))
          throw new ApiError(
            429,
            "Too many messages. Please try again shortly.",
          );
        const message = await createMessage({
          roomId,
          senderId: userId,
          clientId,
          content,
          replyToId,
          attachments,
          albumId,
          mentionedUserIds,
          forwardSource,
          encryptedPayload,
          io,
        });

        // Auto-clear typing indicator when a message is sent
        await conversationActivity.clearDevice(
          roomId,
          userId,
          socket.id,
          order,
        );
        await presence.publishRoomPresence(io, roomId, undefined, userId);

        if (!message._idempotentRetry)
          await require("../services/privacy.service").emitMessage(
            io,
            roomId,
            "receive-message",
            message,
          );
        return message;
      },
    );

    // Starts are rate limited across instances; stops always clear only the
    // originating device. Aggregate snapshots keep other devices visible.
    for (const [event, kind, active] of [
      ["typing", "typing", true],
      ["stop-typing", "typing", false],
      ["start-recording", "recording", true],
      ["stop-recording", "recording", false],
    ])
      onEvent(event, async ({ roomId, [ACTIVITY_ORDER]: order }) => {
        if (!roomId) throw new ApiError(400, "roomId is required");
        if (active) {
          if (!redisClient.isReady)
            throw new ApiError(
              503,
              "Activity updates are temporarily unavailable",
            );
          const allowed = await rateLimit.consumeShared(`activity:${userId}`, {
            windowMs: 60000,
            max: 120,
          });
          if (!allowed) throw new ApiError(429, "Too many activity updates");
        }
        return withRoomMembership(roomId, userId, async (client) => {
          if (
            active &&
            (
              await client.query(
                `SELECT 1 FROM rooms r JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$2 WHERE r.id=$1 AND NOT r.member_can_send AND rm.role<>'admin'`,
                [roomId, userId],
              )
            ).rowCount
          )
            throw new ApiError(
              403,
              "Only admins can send activity in this room",
            );
          if (!socket.connected || !socket.rooms.has(roomId))
            throw new ApiError(
              403,
              "Join this conversation before sharing activity",
            );
          const changed = await conversationActivity.update(
            roomId,
            userId,
            socket.id,
            kind,
            active,
            order,
          );
          if (changed)
            await presence.publishRoomPresence(io, roomId, client, userId);
          return { roomId, accepted: changed };
        });
      });

    // Delivery means a device received message metadata, independent of media
    // downloads. Reading additionally requires a live foreground timeline.
    for (const [event, read] of [
      ["message-read", true],
      ["message-delivered", false],
    ]) {
      onEvent(event, async ({ roomId, messageId }) => {
        if (!roomId || !messageId)
          throw new ApiError(400, "roomId and messageId are required");
        return require("../services/messageReceipt.service").acknowledge({
          roomId,
          messageId,
          userId,
          read,
          io,
          authorize: async () => {
            if (!socket.connected) return false;
            if (!read) return true;
            if (!socket.rooms.has(roomId)) return false;
            if (!redisClient.isReady)
              throw new ApiError(
                503,
                "Read receipts are temporarily unavailable",
              );
            const [lease, meta] = await Promise.all([
              redisClient.zScore("presence:leases", `${userId}:${socket.id}`),
              redisClient.hGetAll(`presence:socket:${socket.id}`),
            ]);
            return (
              Number(lease) > Date.now() &&
              meta.foreground === "1" &&
              meta.roomId === roomId
            );
          },
        });
      });
    }

    // Foreground attention is separate from subscriptions (info pages and
    // background tabs retain subscriptions). Activity updates are serialized;
    // revisions also discard requests whose authorization finished out of order.
    onEvent("heartbeat", async (payload = {}) => {
      activityWork = activityWork
        .catch(() => {})
        .then(async () => {
          const previous = socket.data.activity;
          const revision = Number.isSafeInteger(payload?.revision)
            ? payload.revision
            : previous.revision + 1;
          if (revision < previous.revision || !socket.connected)
            return { available: redisClient.isReady };
          let roomId =
            typeof payload?.roomId === "string" ? payload.roomId : null;
          if (roomId && !/^[0-9a-f-]{36}$/i.test(roomId))
            throw new ApiError(400, "Invalid presence room");
          const activity = {
            foreground: payload?.foreground === true,
            roomId,
            revision,
            order: payload[ACTIVITY_ORDER],
          };
          if (!activity.foreground) activity.roomId = roomId = null;
          let changed;
          if (roomId) {
            try {
              changed = await withRoomMembership(roomId, userId, () =>
                presence.renewSocket(userId, socket.id, activity),
              );
            } catch (error) {
              if (error.status !== 403) throw error;
              activity.roomId = null;
              changed = await presence.renewSocket(userId, socket.id, activity);
            }
          } else
            changed = await presence.renewSocket(userId, socket.id, activity);
          socket.data.activity = activity;
          if (activity.foreground)
            await query(
              "UPDATE users SET last_active_at=NOW() WHERE id=$1 AND (last_active_at IS NULL OR last_active_at<NOW()-INTERVAL '1 minute')",
              [userId],
            );
          if (previous.roomId && previous.roomId !== activity.roomId) {
            await conversationActivity.clearDevice(
              previous.roomId,
              userId,
              socket.id,
              payload[ACTIVITY_ORDER],
            );
            await presence.publishRoomPresence(
              io,
              previous.roomId,
              undefined,
              userId,
            );
          }
          // Rebuild this device's indexes after Redis data loss. Check membership
          // under the same lock as removal, rather than trusting cached Redis sets.
          const rooms = [...socket.rooms].filter((id) =>
            /^[0-9a-f-]{36}$/i.test(id),
          );
          for (const id of rooms) {
            try {
              await withRoomMembership(id, userId, async () => {
                if (socket.connected && socket.rooms.has(id))
                  await presence.userJoinedRoom(userId, id, socket.id);
              });
            } catch (error) {
              if (error.status !== 403) throw error;
              await socket.leave(id);
              await presence.userLeftRoom(userId, id, socket.id);
              socket.emit("room:members", {
                roomId: id,
                userId,
                action: "removed",
              });
            }
          }
          if (changed) await presence.publishUserPresence(io, userId);
          for (const id of rooms)
            if (socket.rooms.has(id))
              await presence.publishRoomPresence(io, id);
          return { available: redisClient.isReady, checkedAt: Date.now() };
        });
      return activityWork;
    });

    // --- disconnect: clean up all presence state ---
    onEvent("disconnect", async () => {
      clearTimeout(expiryTimer);
      // If the user still has another tab open, they are not offline — do not
      // tear down their presence or announce them as gone.
      await activityWork.catch(() => {});
      const leftRooms = await presence.cleanupSocketFromRooms(
        userId,
        socket.id,
      );
      const remainingSockets = await presence.socketDisconnected(
        userId,
        socket.id,
      );

      // Notify each room only when the user's last tab there closed.
      for (const roomId of leftRooms) {
        await presence.publishRoomPresence(io, roomId);
      }
      await presence.publishUserPresence(io, userId);
      if (remainingSockets > 0) return;

      // Remove the account from the online index only after its last device.
      await presence.userDisconnected(userId);
    });
  });

  // --- Start the heartbeat sweep timer ---
  // Expire individual device leases after a crash or sleeping connection.
  presence.startHeartbeatSweep(io);
  const local = io.local || io;
  const unavailable = () => local.emit?.("presence:unavailable");
  const resync = () => local.emit?.("presence:resync");
  redisClient.on("reconnecting", unavailable);
  redisClient.on("end", unavailable);
  redisClient.on("ready", resync);
  io.httpServer?.once("close", () => {
    presence.stopHeartbeatSweep(io);
    redisClient.off("reconnecting", unavailable);
    redisClient.off("end", unavailable);
    redisClient.off("ready", resync);
  });
}

module.exports = registerSocketHandlers;
