const prefix = "conclave:draft:";
const listeners = () =>
  typeof window !== "undefined" &&
  window.dispatchEvent(new Event("conclave:drafts-changed"));
export function readDraft(userId, roomId) {
  if (!userId || !roomId) return { text: "", reply: null };
  try {
    const value = JSON.parse(
      localStorage.getItem(`${prefix}${userId}:${roomId}`) || "null",
    );
    return value && typeof value.text === "string"
      ? value
      : { text: "", reply: null };
  } catch {
    return { text: "", reply: null };
  }
}
export function writeDraft(userId, roomId, text, reply = null) {
  if (!userId || !roomId) return;
  const key = `${prefix}${userId}:${roomId}`;
  try {
    if (text || reply)
      localStorage.setItem(
        key,
        JSON.stringify({ text, reply, updatedAt: Date.now() }),
      );
    else localStorage.removeItem(key);
    listeners();
  } catch {
    /* Storage may be unavailable. The in-memory composer remains usable. */
  }
}
