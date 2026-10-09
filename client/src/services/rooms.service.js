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
