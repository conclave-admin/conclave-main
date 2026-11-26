const crypto = require("crypto");
const { pool, query } = require("../config/db");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");
const { personalRoom } = require("./notification.service");

const ACTIVE = ["ringing", "answered"];
const RING_TIMEOUT_SECONDS = 40;
const MAX_MESH_PARTICIPANTS = 4;
const ICE_STUN = ["stun:stun.l.google.com:19302"];

async function getRoomCallParticipants(db, roomId, userId, callType = "audio") {
  const roomResult = await db.query(
    `SELECT id,type,name FROM rooms WHERE id=$1 AND type IN ('dm','group')
       AND EXISTS(SELECT 1 FROM room_members WHERE room_id=rooms.id AND user_id=$2)`,
    [roomId, userId],
  );
  const room = roomResult.rows[0];
  if (!room) throw new ApiError(404, "This conversation cannot be called");
  const members = await db.query(
    `SELECT u.id,u.display_name,u.avatar_url,u.suspended_at,u.deleted_at
       FROM room_members rm JOIN users u ON u.id=rm.user_id
      WHERE rm.room_id=$1 ORDER BY u.id FOR SHARE OF rm,u`,
    [roomId],
  );
  const people = members.rows;
  const minimum = room.type === "dm" ? 2 : 2;
  if (people.length < minimum || people.length > MAX_MESH_PARTICIPANTS)
    throw new ApiError(409, `Group calls support up to ${MAX_MESH_PARTICIPANTS} people including you`);
  if (room.type === "dm" && people.length !== 2)
    throw new ApiError(409, "This direct conversation is no longer available");
  if (people.some((person) => person.suspended_at || person.deleted_at))
    throw new ApiError(403, "A participant cannot receive calls");
  if (callType === "video" && room.type === "group" && people.length > MAX_MESH_PARTICIPANTS)
    throw new ApiError(409, "This group is too large for a video call");
  const blocked = await db.query(
    `SELECT 1 FROM user_blocks b
      WHERE b.blocker_id=ANY($1::uuid[]) AND b.blocked_id=ANY($1::uuid[]) LIMIT 1`,
    [people.map((person) => person.id)],
  );
  if (blocked.rowCount) throw new ApiError(403, "Calls are unavailable for this conversation");
  return { room, participants: people };
}

async function startCall(io, socket, userId, roomId, callType = "audio") {
  if (!["audio", "video"].includes(callType)) throw new ApiError(400, "Call type must be audio or video");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { room, participants } = await getRoomCallParticipants(db, roomId, userId, callType);
    const participantIds = participants.map((person) => person.id).sort();
    for (const id of participantIds)
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 71))", [id]);
    const current = await getRoomCallParticipants(db, roomId, userId, callType);
    const currentIds = current.participants.map((person) => person.id).sort();
    if (currentIds.length !== participantIds.length || currentIds.some((id, index) => id !== participantIds[index]))
      throw new ApiError(409, "Room membership changed. Try placing the call again.");
    const active = await db.query(
      `SELECT 1 FROM voice_call_participants p JOIN voice_calls c ON c.id=p.call_id
        WHERE p.status IN ('invited','accepted') AND c.status=ANY($1::text[])
          AND p.user_id=ANY($2::uuid[]) LIMIT 1`,
      [ACTIVE, participantIds],
    );
    if (active.rowCount) throw new ApiError(409, "Someone in this conversation is already on a call");
    const calleeId = participants.length === 2 ? participants.find((person) => person.id !== userId).id : null;
    const created = await db.query(
      `INSERT INTO voice_calls(room_id,caller_id,callee_id,call_type)
       VALUES($1,$2,$3,$4) RETURNING id,status,call_type,started_at`,
      [roomId, userId, calleeId, callType],
    );
    const call = created.rows[0];
    await db.query(
      `INSERT INTO voice_call_participants(call_id,user_id,role,status,joined_at)
       VALUES($1,$2,'caller','accepted',NOW())`,
      [call.id, userId],
    );
    const invitees = participants.filter((person) => person.id !== userId);
    for (const invitee of invitees)
      await db.query(
        `INSERT INTO voice_call_participants(call_id,user_id,role,status)
         VALUES($1,$2,'invitee','invited')`,
        [call.id, invitee.id],
      );
    await db.query("COMMIT");
    const caller = participants.find((person) => person.id === userId);
    for (const invitee of invitees)
    io.to(personalRoom(invitee.id)).emit("call:incoming", {
        callId: call.id,
        roomId,
        roomName: room.name,
        roomType: room.type,
        callType,
        startedAt: call.started_at,
      peer: { id: caller.id, display_name: caller.display_name, avatar_url: caller.avatar_url },
    });
    for (const invitee of invitees)
      require("./push.service").sendCallInvitation(invitee.id, {
        id: call.id,
        roomId,
        callType,
      }).catch((error) => console.warn("Call invitation push was skipped", error.message));
    io.to(personalRoom(userId)).except(socket.id).emit("call:outgoing", {
      callId: call.id,
      roomId,
      roomType: room.type,
      callType,
      peers: invitees.map(({ id, display_name, avatar_url }) => ({ id, display_name, avatar_url })),
    });
    return {
      call: { id: call.id, roomId, roomName: room.name, roomType: room.type, callType, status: call.status, startedAt: call.started_at },
      peers: invitees.map(({ id, display_name, avatar_url }) => ({ id, display_name, avatar_url })),
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

async function getAuthorizedCall(db, callId, userId, lock = false) {
  const result = await db.query(
    `SELECT c.*,r.name AS room_name,r.type AS room_type FROM voice_calls c
       JOIN rooms r ON r.id=c.room_id JOIN voice_call_participants p ON p.call_id=c.id
      WHERE c.id=$1 AND p.user_id=$2 ${lock ? "FOR UPDATE OF c,p" : ""}`,
    [callId, userId],
  );
  if (!result.rowCount) throw new ApiError(404, "Call not found");
  return result.rows[0];
}

async function acceptedPeers(db, callId, userId) {
  const result = await db.query(
    `SELECT u.id,u.display_name,u.avatar_url FROM voice_call_participants p
       JOIN users u ON u.id=p.user_id
      WHERE p.call_id=$1 AND p.status='accepted' AND p.user_id<>$2 ORDER BY u.display_name`,
    [callId, userId],
  );
  return result.rows;
}

async function acceptCall(io, socket, userId, callId) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const call = await getAuthorizedCall(db, callId, userId, true);
    const invite = await db.query(
      `SELECT status FROM voice_call_participants WHERE call_id=$1 AND user_id=$2 FOR UPDATE`,
      [callId, userId],
    );
    if (invite.rows[0]?.status !== "invited") throw new ApiError(409, "This call is no longer ringing on this device");
    if (!ACTIVE.includes(call.status) || Date.now() - new Date(call.started_at).getTime() >= RING_TIMEOUT_SECONDS * 1000)
      throw new ApiError(409, "This call is no longer ringing");
    await getRoomCallParticipants(db, call.room_id, userId, call.call_type);
    await db.query(
      `UPDATE voice_call_participants SET status='accepted',joined_at=NOW()
        WHERE call_id=$1 AND user_id=$2 AND status='invited'`,
      [callId, userId],
    );
    await db.query("UPDATE voice_calls SET status='answered',answered_at=COALESCE(answered_at,NOW()) WHERE id=$1 AND status='ringing'", [callId]);
    const peers = await acceptedPeers(db, callId, userId);
    const currentUser = await db.query("SELECT display_name,avatar_url FROM users WHERE id=$1", [userId]);
    await db.query("COMMIT");
    const participant = { id: userId, display_name: currentUser.rows[0]?.display_name || "Conclave member", avatar_url: currentUser.rows[0]?.avatar_url };
    for (const peer of peers)
      io.to(personalRoom(peer.id)).emit("call:participant-joined", { callId, roomId: call.room_id, callType: call.call_type, participant });
    io.to(personalRoom(userId)).except(socket.id).emit("call:participant-accepted-elsewhere", { callId });
    return {
      callId,
      roomId: call.room_id,
      roomName: call.room_name,
      roomType: call.room_type,
      callType: call.call_type,
      peers,
      role: "participant",
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

async function finishCall(io, socket, userId, callId, action) {
  if (!["decline", "end"].includes(action)) throw new ApiError(400, "Invalid call action");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const call = await getAuthorizedCall(db, callId, userId, true);
    const own = await db.query(
      `SELECT role,status FROM voice_call_participants WHERE call_id=$1 AND user_id=$2 FOR UPDATE`,
      [callId, userId],
    );
    if (!ACTIVE.includes(call.status)) {
      await db.query("COMMIT");
      return { callId, status: call.status, roomId: call.room_id };
    }
    const isCaller = own.rows[0].role === "caller";
    if (action === "decline" && isCaller) throw new ApiError(403, "The caller cannot decline their own call");
    if (action === "decline" && own.rows[0].status !== "invited")
      throw new ApiError(409, "Only a ringing call can be declined");
    const inviteeStatus = action === "decline" ? "declined" : "left";
    await db.query(
      `UPDATE voice_call_participants SET status=$3,left_at=NOW()
        WHERE call_id=$1 AND user_id=$2`,
      [callId, userId, inviteeStatus],
    );
    let nextStatus = call.status;
    if (isCaller) {
      nextStatus = call.status === "ringing" ? "cancelled" : "ended";
      await db.query(
        `UPDATE voice_call_participants SET status='left',left_at=COALESCE(left_at,NOW())
          WHERE call_id=$1 AND user_id<>$2 AND status IN ('invited','accepted')`,
        [callId, userId],
      );
    } else {
      const remaining = await db.query(
        `SELECT 1 FROM voice_call_participants WHERE call_id=$1 AND role='invitee'
          AND status IN ('invited','accepted') LIMIT 1`,
        [callId],
      );
      const accepted = await db.query(
        `SELECT 1 FROM voice_call_participants WHERE call_id=$1 AND role='invitee' AND status='accepted' LIMIT 1`,
        [callId],
      );
      if (!remaining.rowCount) nextStatus = accepted.rowCount || call.answered_at ? "ended" : "declined";
    }
    if (!ACTIVE.includes(nextStatus))
      await db.query(
        `UPDATE voice_calls SET status=$2,ended_at=NOW(),ended_by=$3,end_reason=$4 WHERE id=$1`,
        [callId, nextStatus, userId, action],
      );
    const others = await db.query(
      `SELECT user_id FROM voice_call_participants WHERE call_id=$1 AND user_id<>$2 AND status IN ('invited','accepted')`,
      [callId, userId],
    );
    await db.query("COMMIT");
    if (!ACTIVE.includes(nextStatus)) {
      for (const participant of await query("SELECT user_id FROM voice_call_participants WHERE call_id=$1", [callId]).then((r) => r.rows))
        io.to(personalRoom(participant.user_id)).emit("call:ended", { callId, status: nextStatus, endedBy: userId, roomId: call.room_id });
    } else {
      for (const participant of others.rows)
        io.to(personalRoom(participant.user_id)).emit("call:participant-left", { callId, participantId: userId, status: inviteeStatus });
      const ownDevices = socket?.id ? io.to(personalRoom(userId)).except(socket.id) : io.to(personalRoom(userId));
      ownDevices.emit("call:participant-left", { callId, participantId: userId, status: inviteeStatus });
    }
    return { callId, status: nextStatus, roomId: call.room_id };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

async function relaySignal(io, userId, callId, toUserId, signal) {
  const encoded = JSON.stringify(signal);
  if (!encoded || Buffer.byteLength(encoded) > 16 * 1024)
    throw new ApiError(413, "Call signal is too large");
  if (!signal || !["offer", "answer", "ice-candidate"].includes(signal.type) || !signal.data || typeof signal.data !== "object")
    throw new ApiError(400, "Invalid call signal");
  const call = await getAuthorizedCall(pool, callId, userId);
  if (call.status !== "answered") throw new ApiError(409, "The call has not been answered");
  if (typeof toUserId !== "string" || toUserId === userId) throw new ApiError(400, "A call participant is required");
  const participants = await query(
    `SELECT COUNT(*)::int AS count FROM voice_call_participants
      WHERE call_id=$1 AND user_id=ANY($2::uuid[]) AND status='accepted'`,
    [callId, [userId, toUserId]],
  );
  if (participants.rows[0].count !== 2) throw new ApiError(403, "Both people must have joined the call");
  await getRoomCallParticipants(pool, call.room_id, userId, call.call_type);
  io.to(personalRoom(toUserId)).emit("call:signal", { callId, from: userId, signal });
  return { delivered: true };
}

async function expireRingingCalls(io) {
  const expired = await query(
    `UPDATE voice_call_participants p SET status='missed',left_at=NOW()
      FROM voice_calls c WHERE c.id=p.call_id AND c.status IN ('ringing','answered')
        AND p.role='invitee' AND p.status='invited'
        AND p.invited_at<NOW()-($1::int * INTERVAL '1 second')
      RETURNING p.call_id,p.user_id,c.room_id`,
    [RING_TIMEOUT_SECONDS],
  );
  for (const participant of expired.rows)
    io.to(personalRoom(participant.user_id)).emit("call:ended", { callId: participant.call_id, roomId: participant.room_id, status: "missed" });
  const finished = await query(
    `UPDATE voice_calls c SET status=CASE WHEN EXISTS(
      SELECT 1 FROM voice_call_participants p WHERE p.call_id=c.id AND p.status='accepted' AND p.role='invitee'
    ) THEN 'answered' ELSE 'missed' END,
      ended_at=CASE WHEN EXISTS(
        SELECT 1 FROM voice_call_participants p WHERE p.call_id=c.id AND p.status='accepted' AND p.role='invitee'
      ) THEN c.ended_at ELSE NOW() END
     WHERE c.status='ringing' AND c.started_at<NOW()-($1::int * INTERVAL '1 second')
     RETURNING id,room_id,status`,
    [RING_TIMEOUT_SECONDS],
  );
  for (const call of finished.rows)
    if (call.status === "missed")
      for (const participant of await query("SELECT user_id FROM voice_call_participants WHERE call_id=$1", [call.id]).then((r) => r.rows))
        io.to(personalRoom(participant.user_id)).emit("call:ended", { callId: call.id, roomId: call.room_id, status: call.status });
  const emptyCalls = await query(
    `UPDATE voice_calls c SET status='ended',ended_at=NOW(),end_reason='no_participants'
      WHERE c.status='answered'
        AND EXISTS (SELECT 1 FROM voice_call_participants p WHERE p.call_id=c.id AND p.role='invitee')
        AND NOT EXISTS (SELECT 1 FROM voice_call_participants p WHERE p.call_id=c.id AND p.role='invitee' AND p.status IN ('invited','accepted'))
      RETURNING id,room_id`,
  );
  for (const call of emptyCalls.rows)
    for (const participant of await query("SELECT user_id FROM voice_call_participants WHERE call_id=$1", [call.id]).then((r) => r.rows))
      io.to(personalRoom(participant.user_id)).emit("call:ended", { callId: call.id, roomId: call.room_id, status: "ended" });
  const stale = await query(
    `UPDATE voice_calls SET status='ended',ended_at=NOW(),end_reason='maximum_duration'
     WHERE status='answered' AND answered_at<NOW()-INTERVAL '4 hours'
     RETURNING id,room_id`,
  );
  for (const call of stale.rows)
    for (const participant of await query("SELECT user_id FROM voice_call_participants WHERE call_id=$1", [call.id]).then((r) => r.rows))
      io.to(personalRoom(participant.user_id)).emit("call:ended", { callId: call.id, roomId: call.room_id, status: "ended" });
}

let expiryTimer = null;
function start(io) {
  if (expiryTimer) return;
  expiryTimer = setInterval(() => expireRingingCalls(io).catch((error) => console.error("Call expiry failed", error.message)), 5000);
  expiryTimer.unref?.();
}
function stop() {
  if (expiryTimer) clearInterval(expiryTimer);
  expiryTimer = null;
}

function iceServers(userId) {
  const urls = env.calls.turnUrls;
  const servers = [{ urls: env.calls.stunUrls.length ? env.calls.stunUrls : ICE_STUN }];
  if (env.calls.turnSharedSecret && urls.length) {
    const expires = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
    const username = `${expires}:${userId}`;
    const credential = crypto.createHmac("sha1", env.calls.turnSharedSecret).update(username).digest("base64");
    servers.push({ urls, username, credential });
  }
  return { iceServers: servers, relayConfigured: servers.length > 1 };
}

async function listHistory(userId) {
  const result = await query(
    `SELECT c.id,c.room_id,c.caller_id,c.callee_id,c.call_type,c.status,c.started_at,c.answered_at,c.ended_at,c.ended_by,c.end_reason,
      r.name AS room_name,r.type AS room_type,
      COALESCE(jsonb_agg(jsonb_build_object('id',peer.id,'display_name',peer.display_name,'avatar_url',peer.avatar_url))
        FILTER (WHERE peer.id IS NOT NULL AND peer.id<>$1),'[]'::jsonb) AS peers
       FROM voice_calls c JOIN rooms r ON r.id=c.room_id
       JOIN voice_call_participants mine ON mine.call_id=c.id AND mine.user_id=$1
       JOIN voice_call_participants other ON other.call_id=c.id AND other.user_id<>$1
       JOIN users peer ON peer.id=other.user_id
      WHERE NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
          (b.blocker_id=$1 AND b.blocked_id=peer.id) OR (b.blocked_id=$1 AND b.blocker_id=peer.id))
      GROUP BY c.id,r.name,r.type ORDER BY c.started_at DESC LIMIT 100`,
    [userId],
  );
  return result.rows;
}

async function listPending(userId) {
  const result = await query(
    `SELECT c.id AS "callId",c.room_id AS "roomId",r.name AS "roomName",r.type AS "roomType",
      c.call_type AS "callType",c.status,c.started_at AS "startedAt",
      caller.id AS peer_id,caller.display_name AS peer_name,caller.avatar_url AS peer_avatar
     FROM voice_call_participants mine JOIN voice_calls c ON c.id=mine.call_id
     JOIN rooms r ON r.id=c.room_id JOIN users caller ON caller.id=c.caller_id
     WHERE mine.user_id=$1 AND mine.role='invitee' AND mine.status='invited'
       AND c.status=ANY($2::text[]) AND mine.invited_at>NOW()-($3::int*INTERVAL '1 second')
       AND EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=r.id AND rm.user_id=$1)
       AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE
         (b.blocker_id=$1 AND b.blocked_id=caller.id) OR (b.blocker_id=caller.id AND b.blocked_id=$1))
     ORDER BY c.started_at LIMIT 3`,
    [userId, ACTIVE, RING_TIMEOUT_SECONDS],
  );
  return result.rows.map(({ peer_id, peer_name, peer_avatar, ...call }) => ({
    ...call,
    peer: { id: peer_id, display_name: peer_name, avatar_url: peer_avatar },
  }));
}

module.exports = { startCall, acceptCall, finishCall, relaySignal, expireRingingCalls, start, stop, iceServers, listHistory, listPending, RING_TIMEOUT_SECONDS };
