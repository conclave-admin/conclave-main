import { getMessageSnapshots } from "./messages.service";
import { applyAccountClear } from "../lib/clearedConversations";
import { getSessionUserId } from "../lib/session";
import { api } from "../lib/api";
import {
  isDevAuthBypass,
  previewRoom,
  previewRooms,
  previewUser,
} from "../config/devPreview";

export async function resolveChatPreview(roomId, message) {
  if (
    !message ||
    message.is_deleted ||
    (message.content !== "[Encrypted message]" && !message.encrypted_payload)
  )
    return message;
  const account = getSessionUserId();
  try {
    const result = await getMessageSnapshots(roomId, [message.id]);
    if (getSessionUserId() !== account) throw new Error("Account changed");
    const decoded = result.messages.find((m) => m.id === message.id);
    if (!decoded) return null;
    if (!decoded._decrypted)
      return {
        ...message,
        content: "Connect this device to view the message",
        _previewState: "keys",
      };
    return {
      ...message,
      ...decoded,
      has_attachment: Boolean(decoded.attachments?.length),
      attachment_type: decoded.attachments?.[0]?.mime_type,
    };
  } catch (error) {
    if (getSessionUserId() !== account) throw error;
    return {
      ...message,
      content: "Connect to load this message",
      _previewState: "network",
    };
  }
}

export async function listRooms({ onPreview } = {}) {
  if (isDevAuthBypass) return previewRooms;
  const userId = getSessionUserId();
  const { data } = await api.get("/rooms");
  if (getSessionUserId() === userId)
    for (const room of data.data)
      applyAccountClear(
        userId,
        room.id,
        room.cleared_sequence,
        room.cleared_at,
      );
  const rows = data.data;
  let index = 0;
  const resolveAll = () =>
    Promise.all(
      Array.from({ length: Math.min(4, rows.length) }, async () => {
        while (index < rows.length) {
          const room = rows[index++];
          room.last_message = await resolveChatPreview(
            room.id,
            room.last_message,
          );
          if (getSessionUserId() !== userId) throw new Error("Account changed");
          onPreview?.(room.id, room.last_message);
        }
      }),
    );
  if (onPreview) {
    void resolveAll().catch(() => {});
    return rows.map((room) => ({
      ...room,
      last_message:
        room.last_message?.content === "[Encrypted message]"
          ? {
              ...room.last_message,
              content: "Loading message…",
              _previewLoading: true,
            }
          : room.last_message,
    }));
  }
  await resolveAll();
  if (getSessionUserId() !== userId) throw new Error("Account changed");
  return rows;
}

export async function discoverRooms({ q = "", page = 1 } = {}) {
  if (isDevAuthBypass) {
    const room = {
      id: "preview-public-room",
      name: "Conclave Community",
      description:
        "Open announcements and product feedback for the preview workspace.",
      slug: "conclave-community",
      member_count: 24,
    };
    const term = q.trim().toLowerCase();
    const rooms = previewRooms.some((item) => item.id === room.id)
      ? []
      : !term || `${room.name} ${room.description}`.toLowerCase().includes(term)
        ? [room]
        : [];
    return { rooms: page === 1 ? rooms : [], page, hasMore: false };
  }
  const { data } = await api.get("/rooms/discover", { params: { q, page } });
  return data.data;
}

export async function joinPublicRoom(roomId) {
  if (isDevAuthBypass) {
    if (!previewRooms.some((room) => room.id === roomId)) {
      previewRooms.push({
        id: roomId,
        name: "Conclave Community",
        display_name: "Conclave Community",
        description:
          "Open announcements and product feedback for the preview workspace.",
        slug: "conclave-community",
        type: "public",
        member_count: 1,
        my_role: "member",
        has_message: false,
        unread_count: 0,
        members: [
          {
            ...previewUser,
            role: "member",
            joined_at: new Date().toISOString(),
          },
        ],
      });
    }
    return { roomId, joined: true, existing: false };
  }
  const { data } = await api.post(`/rooms/${roomId}/join`);
  return data.data;
}

export async function updateRoomPreferences(roomId, updates) {
  if (isDevAuthBypass) return updates;
  const { data } = await api.patch(`/rooms/${roomId}/preferences`, updates);
  return data.data;
}

export async function getRoom(roomId) {
  if (isDevAuthBypass) {
    const found = previewRooms.find((room) => room.id === roomId);
    if (!found)
      throw Object.assign(
        new Error("You no longer have access to this conversation."),
        {
          response: {
            status: 403,
            data: {
              message: "You no longer have access to this conversation.",
            },
          },
        },
      );
    return { ...found, id: roomId };
  }
  const userId = getSessionUserId();
  const { data } = await api.get(`/rooms/${roomId}`);
  if (getSessionUserId() === userId)
    applyAccountClear(
      userId,
      roomId,
      data.data.cleared_sequence,
      data.data.cleared_at,
    );
  return data.data;
}

/**
 * Create a room. `type: 'dm'` takes exactly one other member and is idempotent:
 * if the pair already has a DM the server answers 200 with `existing: true` and
 * the room that already exists, rather than 201 and a duplicate. Callers must
 * handle both — the room to open is the same either way, which is the point.
 */
export async function createRoom({ name, type = "group", memberIds = [] }) {
  if (isDevAuthBypass) {
    const other = memberIds[0];
    if (type === "dm" && memberIds.length === 1) {
      const existing = previewRooms.find(
        (room) =>
          room.type === "dm" && room.members.some((m) => m.id === other),
      );
      if (existing) return { ...existing, existing: true };
    }
    // A DM arrives with no name — the server names it after the other person,
    // and so does this. `name.toLowerCase()` used to run unconditionally here
    // and threw on undefined, so bypass mode failed differently from the real
    // API rather than agreeing with it.
    const label = name?.trim() || other || "Direct message";
    const created = {
      id: `dev-room-${previewRooms.length + 1}`,
      name: label,
      slug: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      type,
      member_count: memberIds.length + 1,
      my_role: "admin",
      display_name: type === "dm" ? other : label,
      display_avatar: null,
      has_message: false,
      unread_count: 0,
      last_message: null,
      members: [
        { ...previewUser, role: "admin", joined_at: new Date().toISOString() },
        ...memberIds.map((id, i) => ({
          id,
          display_name: id,
          avatar_url: null,
          role: "member",
          joined_at: new Date().toISOString(),
          last_seen_at: null,
        })),
      ],
    };
    previewRooms.push(created);
    return created;
  }
  const { data } = await api.post("/rooms", { name, type, memberIds });
  return data.data;
}

/**
 * Rename a room or set its description. Admin only — the server enforces that,
 * and the UI hides the control for anyone else as a courtesy rather than as the
 * check itself.
 *
 * `slug` is not sent and cannot be: the server derives it and explicitly
 * excludes it from what a caller may write, so a rename leaves it as first
 * allocated.
 */
export async function updateRoom(roomId, updates) {
  if (isDevAuthBypass) {
    const room = previewRooms.find((r) => r.id === roomId);
    if (room) {
      if (typeof updates.name === "string" && updates.name.trim()) {
        room.name = updates.name.trim();
        // display_name mirrors name for a group, so both move together or the
        // rail and the header would disagree after a rename.
        if (room.type !== "dm") room.display_name = room.name;
      }
      if (typeof updates.description === "string")
        room.description = updates.description;
      if (
        typeof updates.avatar_url === "string" ||
        updates.avatar_url === null
      ) {
        room.avatar_url = updates.avatar_url;
        room.display_avatar = updates.avatar_url;
      }
    }
    return room ? { ...room } : null;
  }
  const { data } = await api.patch(`/rooms/${roomId}`, updates);
  return data.data;
}

export async function addMember(roomId, userId) {
  if (isDevAuthBypass) {
    const room = previewRooms.find((r) => r.id === roomId);
    if (room) {
      room.members.push({
        id: userId,
        display_name: userId,
        avatar_url: null,
        role: "member",
        joined_at: new Date().toISOString(),
        last_seen_at: null,
      });
      room.member_count = room.members.length;
    }
    return { roomId, userId, role: "member" };
  }
  const { data } = await api.post(`/rooms/${roomId}/members`, { userId });
  return data.data;
}

/**
 * Remove a member. Calling this with your own id is how you leave.
 *
 * The last admin cannot be removed — the server answers 409 rather than letting
 * a room become one nobody can administer — so a failure here is worth
 * distinguishing from the permission failures, which mean something different to
 * the person reading the message.
 */
export async function removeMember(roomId, userId) {
  if (isDevAuthBypass) {
    const room = previewRooms.find((r) => r.id === roomId);
    if (room) {
      const admins = room.members.filter((m) => m.role === "admin");
      const target = room.members.find((m) => m.id === userId);
      if (target?.role === "admin" && admins.length <= 1) {
        throw new Error("A room must keep at least one admin");
      }
      room.members = room.members.filter((m) => m.id !== userId);
      room.member_count = room.members.length;
    }
    return { roomId, userId, removed: true };
  }
  const { data } = await api.delete(`/rooms/${roomId}/members/${userId}`);
  return data.data;
}

export async function setMemberRole(roomId, userId, role) {
  if (isDevAuthBypass) {
    const room = previewRooms.find((r) => r.id === roomId);
    const target = room?.members.find((m) => m.id === userId);
    if (target) {
      const admins = room.members.filter((m) => m.role === "admin");
      if (target.role === "admin" && role === "member" && admins.length <= 1) {
        throw new Error("A room must keep at least one admin");
      }
      target.role = role;
    }
    return { roomId, userId, role };
  }
  const { data } = await api.patch(`/rooms/${roomId}/members/${userId}`, {
    role,
  });
  return data.data;
}

/**
 * Mark a room read.
 *
 * POST, not PATCH — the server registers `/:roomId/seen` as POST, and a wrong
 * method is a 404 that looks exactly like a missing endpoint.
 *
 * The server advances room_members.last_seen_at and emits `room-seen` to the
 * room, which is what stops a room re-counting itself as unread, what empties
 * the catch-up card for that room, and what advances the read pointer other
 * members' clients draw their ticks from.
 */
export async function markRoomSeen(roomId) {
  if (isDevAuthBypass) return { lastSeenAt: new Date().toISOString() };
  const { data } = await api.post(`/rooms/${roomId}/seen`);
  return data.data;
}
