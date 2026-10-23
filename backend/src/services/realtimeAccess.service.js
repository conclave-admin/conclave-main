const { pool } = require("../config/db");
const presence = require("./presence.service");
const ApiError = require("../utils/ApiError");

const CONTROL_EVENT = "security:revoke-access";

async function revokeLocal(io, request) {
  for (const socket of io.of("/").sockets.values()) {
    if (request.kind === "room" && socket.user?.id === request.userId) {
      await socket.leave(request.roomId);
    } else if (
      request.kind === "session" &&
      socket.data.sessionId === request.sessionId
    ) {
      socket.emit("session:revoked", { sessionId: request.sessionId });
      socket.disconnect(true);
    }
  }
}

function registerAccessControl(io) {
  // A namespace/server event, not a client socket event. Redis-adapter peers
  // acknowledge only after their local sockets have actually lost access.
  io.on(CONTROL_EVENT, async (request, acknowledge) => {
    try {
      await revokeLocal(io, request);
      acknowledge({ ok: true });
    } catch (error) {
      console.error("Realtime access revocation failed", {
        message: error.message,
      });
      acknowledge({ ok: false });
    }
  });
}

async function revokeAcrossCluster(io, request) {
  if (!io) return;
  try {
    await revokeLocal(io, request);
    if ((await io.of("/").adapter.serverCount()) > 1) {
      const responses = await io.serverSideEmitWithAck(CONTROL_EVENT, request);
      if (responses.some((response) => !response?.ok))
        throw new Error("A peer could not revoke access");
    }
  } catch (error) {
    console.error("Could not revoke access across realtime servers", {
      message: error.message,
    });
    throw new ApiError(
      503,
      "Could not revoke realtime access. Please try again.",
    );
  }
}

async function revokeRoomAccess(io, roomId, userId) {
  await revokeAcrossCluster(io, { kind: "room", roomId, userId });
  await presence.revokeUserRoom(userId, roomId);
}

async function revokeSessionAccess(io, sessionId) {
  await revokeAcrossCluster(io, { kind: "session", sessionId });
}

async function withRoomMembership(roomId, userId, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Removal holds FOR UPDATE on this same row until eviction and cleanup
    // finish. An in-flight join/typing event cannot re-add a removed member.
    await client.query("SELECT id FROM rooms WHERE id = $1 FOR SHARE", [
      roomId,
    ]);
    const membership = await client.query(
      "SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2",
      [roomId, userId],
    );
    if (!membership.rows.length)
      throw new ApiError(403, "You are not a member of this room");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  registerAccessControl,
  revokeRoomAccess,
  revokeSessionAccess,
  withRoomMembership,
};
