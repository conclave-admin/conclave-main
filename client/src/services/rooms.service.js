import { api } from '../lib/api';
import { isDevAuthBypass, previewDmRoom, previewRoom } from '../config/devPreview';

export async function listRooms() {
  if (isDevAuthBypass) return [previewRoom, previewDmRoom];
  const { data } = await api.get('/rooms');
  return data.data;
}

export async function getRoom(roomId) {
  if (isDevAuthBypass) return { ...(roomId === previewDmRoom.id ? previewDmRoom : previewRoom), id: roomId };
  const { data } = await api.get(`/rooms/${roomId}`);
  return data.data;
}

/**
 * Mark a room read.
 *
 * The server advances room_members.last_seen_at, which is what both the
 * unread_count on the chat row and the time window of GET /digest filter
 * against — so this call is what stops a room re-counting itself as unread
 * and what empties the catch-up card for that room.
 */
export async function markRoomSeen(roomId) {
  if (isDevAuthBypass) return { updated: 1 };
  const { data } = await api.patch(`/rooms/${roomId}/seen`);
  return data.data;
}
