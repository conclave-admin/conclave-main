import { api } from "../lib/api";

export async function listRoomEvents(roomId) {
  const { data } = await api.get(`/rooms/${roomId}/events`);
  return data.data;
}
export async function createRoomEvent(roomId, payload) {
  const { data } = await api.post(`/rooms/${roomId}/events`, payload);
  return data.data;
}
export async function updateRoomEvent(roomId, eventId, payload) {
  const { data } = await api.patch(`/rooms/${roomId}/events/${eventId}`, payload);
  return data.data;
}
export async function cancelRoomEvent(roomId, eventId) {
  const { data } = await api.delete(`/rooms/${roomId}/events/${eventId}`);
  return data.data;
}
export async function respondToRoomEvent(roomId, eventId, response) {
  const { data } = await api.put(`/rooms/${roomId}/events/${eventId}/rsvp`, { response });
  return data.data;
}
