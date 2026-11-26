const key = (userId, roomId) => `conclave:reading:${userId}:${roomId}`;
export function readPosition(userId, roomId) {
  try {
    const p = JSON.parse(localStorage.getItem(key(userId, roomId)) || "null");
    return p?.id && typeof p.offset === "number" ? p : null;
  } catch {
    return null;
  }
}
export function savePosition(userId, roomId, position) {
  if (!userId || !roomId) return;
  try {
    localStorage.setItem(key(userId, roomId), JSON.stringify(position));
  } catch {}
}
