const fallback = new Map();
const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return fallback.get(key) || null;
  }
};
const write = (key, value) => {
  fallback.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Server remains authoritative if browser storage is unavailable. */
  }
};
const keyFor = (userId, roomId) => `conclave:cleared:${userId}:${roomId}`;
const accountKey = (userId, roomId) =>
  `conclave:account-cleared:${userId}:${roomId}`;
export function getConversationClearTime(userId, roomId) {
  if (!userId || !roomId || typeof localStorage === "undefined") return 0;
  return Number(read(keyFor(userId, roomId)) || 0);
}
export function getAccountClearSequence(userId, roomId) {
  if (!userId || !roomId || typeof localStorage === "undefined") return "0";
  const value = read(accountKey(userId, roomId)) || "0";
  return /^\d+$/.test(value) ? value : "0";
}
export function conversationMessageVisible(message, userId, roomId) {
  if (message._optimistic) return true;
  if (
    new Date(message.created_at).getTime() <=
    getConversationClearTime(userId, roomId)
  )
    return false;
  const boundary = getAccountClearSequence(userId, roomId);
  try {
    return message.room_sequence
      ? BigInt(message.room_sequence) > BigInt(boundary)
      : BigInt(boundary) === 0n &&
          !read(`${accountKey(userId, roomId)}:exists`);
  } catch {
    return false;
  }
}
export function applyAccountClear(userId, roomId, sequence, clearedAt) {
  if (!userId || !roomId || !/^\d+$/.test(String(sequence))) return;
  const marker = `${accountKey(userId, roomId)}:exists`;
  if (
    BigInt(sequence) <= BigInt(getAccountClearSequence(userId, roomId)) &&
    (!clearedAt || read(marker))
  )
    return;
  if (clearedAt || BigInt(sequence) > 0n) write(marker, "true");
  sequence =
    BigInt(sequence) > BigInt(getAccountClearSequence(userId, roomId))
      ? String(sequence)
      : getAccountClearSequence(userId, roomId);
  write(accountKey(userId, roomId), String(sequence));
  window.dispatchEvent(
    new CustomEvent("conclave:conversation-cleared", {
      detail: {
        userId,
        roomId,
        scope: "account",
        sequence: String(sequence),
        clearedAt: getConversationClearTime(userId, roomId),
      },
    }),
  );
}
export async function clearConversationForMe(
  userId,
  roomId,
  scope = "account",
) {
  if (scope === "device") {
    const clearedAt = Date.now();
    localStorage.setItem(keyFor(userId, roomId), String(clearedAt));
    window.dispatchEvent(
      new CustomEvent("conclave:conversation-cleared", {
        detail: { userId, roomId, clearedAt, scope },
      }),
    );
    return;
  }
  const { api } = await import("./api");
  const { getSessionUserId } = await import("./session");
  if (getSessionUserId() !== userId)
    throw new Error("Account changed. Reopen the conversation.");
  const { data } = await api.post(`/rooms/${roomId}/clear`);
  if (getSessionUserId() !== userId) return;
  applyAccountClear(
    userId,
    roomId,
    data.data.cleared_sequence,
    data.data.cleared_at,
  );
  return data.data;
}
