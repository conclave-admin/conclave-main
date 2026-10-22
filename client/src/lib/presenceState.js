import { activityExpiries } from './conversationActivity.js';
export const PRESENCE_FRESH_MS = 45000;
export const TYPING_FRESH_MS = 5000;

export function roomPresenceSnapshot(payload, now = Date.now()) {
  return {
    available: payload.available === true,
    activityVersion: payload.activityVersion,
    hidden: new Set(payload.hiddenUserIds || []),
    online: new Set(payload.onlineUserIds || []),
    viewing: new Set(payload.viewingUserIds || []),
    typing: activityExpiries(payload, 'typing', now),
    recording: activityExpiries(payload, 'recording', now),
    receivedAt: now,
  };
}
export function presenceStatus(snapshot, userId, connected = true, now = Date.now()) {
  if (snapshot?.hidden?.has(userId)) return 'unknown';
  if (!connected || !snapshot?.available || now - snapshot.receivedAt >= PRESENCE_FRESH_MS) return 'unknown';
  if (!snapshot.online.has(userId)) return 'offline';
  if ((snapshot.recording?.get(userId) || 0) > now) return 'recording';
  if ((snapshot.typing.get(userId) || 0) > now) return 'typing';
  return snapshot.viewing.has(userId) ? 'viewing' : 'online';
}
export function presenceLabel(status) {
  return { recording: 'Recording a voice message…', typing: 'Typing…', viewing: 'Viewing this conversation', online: 'Online', offline: 'Offline', unknown: 'Presence unavailable' }[status] || 'Presence unavailable';
}
