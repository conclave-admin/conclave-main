import { sharedUrls } from "../lib/sharedLinks";
export { sharedUrls } from "../lib/sharedLinks";
import { api } from "../lib/api";
import { localConversationMessages } from "./messages.service";
import { getSessionUserId } from "../lib/session";
import {
  conversationMessageVisible,
  applyAccountClear,
} from "../lib/clearedConversations";
import { isDevAuthBypass } from "../config/devPreview";
export async function management(roomId) {
  if (isDevAuthBypass)
    return {
      preferences: {},
      invites: [],
      requests: [],
      member_can_send: true,
      member_can_invite: false,
      storage: { bytes: "0", attachment_count: 0 },
    };
  const userId = getSessionUserId(),
    { data } = await api.get(`/rooms/${roomId}/management`);
  if (getSessionUserId() !== userId) throw new Error("Account changed");
  applyAccountClear(
    userId,
    roomId,
    data.data.cleared_sequence,
    data.data.cleared_at,
  );
  return data.data;
}
export const changeRoomSettings = async (roomId, values) =>
  (await api.patch(`/rooms/${roomId}/settings`, values)).data.data;
export const createInvitation = async (roomId, values) =>
  (await api.post(`/rooms/${roomId}/invitations`, values)).data.data;
export const revokeInvitation = async (roomId, id) =>
  (await api.delete(`/rooms/${roomId}/invitations/${id}`)).data.data;
export const acceptInvitation = async (token) =>
  (await api.post("/rooms/invitations/accept", { token })).data.data;
export const reviewJoin = async (roomId, userId, decision) =>
  (await api.post(`/rooms/${roomId}/requests/${userId}`, { decision })).data
    .data;
export const handoverAdmin = async (roomId, successorId) =>
  (await api.post(`/rooms/${roomId}/handover`, { successorId })).data.data;
export async function sharedLinks(room, before) {
  const userId = getSessionUserId();
  if (room.encryption_mode === "e2ee-v1") {
    const messages = (await localConversationMessages(room.id))
      .filter(
        (m) =>
          m._decrypted &&
          !m.is_deleted &&
          !m.deleted_at &&
          conversationMessageVisible(m, userId, room.id) &&
          (!before || BigInt(m.room_sequence) < BigInt(before)) &&
          sharedUrls(m.content).length,
      )
      .sort((a, b) =>
        BigInt(a.room_sequence) > BigInt(b.room_sequence) ? -1 : 1,
      );
    return {
      messages: messages.slice(0, 25),
      nextCursor: messages.length > 25 ? messages[24].room_sequence : null,
    };
  }
  if (isDevAuthBypass) return { messages: [], nextCursor: null };
  const result = (
    await api.get(`/rooms/${room.id}/links`, { params: { before } })
  ).data.data;
  if (getSessionUserId() !== userId) throw new Error("Account changed");
  return {
    ...result,
    messages: result.messages.filter((m) =>
      conversationMessageVisible(m, userId, room.id),
    ),
  };
}

export const invitationStatus = async (token) =>
  (await api.post("/rooms/invitations/status", { token })).data.data;
