const keyFor = (userId, roomId) => `conclave:cleared:${userId}:${roomId}`;

export function getConversationClearTime(userId, roomId) {
  if (!userId || !roomId || typeof localStorage === 'undefined') return 0;
  return Number(localStorage.getItem(keyFor(userId, roomId)) || 0);
}

export function clearConversationForMe(userId, roomId) {
  const clearedAt = Date.now();
  localStorage.setItem(keyFor(userId, roomId), String(clearedAt));
  window.dispatchEvent(new CustomEvent('conclave:conversation-cleared', { detail: { userId, roomId, clearedAt } }));
}
