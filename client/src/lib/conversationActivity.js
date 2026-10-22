export const ACTIVITY_TTL_MS = 5000;
export const ACTIVITY_PULSE_MS = 2500;

export function activityExpiries(payload, kind, now = Date.now()) {
  const entries = Array.isArray(payload.activity)
    ? payload.activity.filter(entry => entry.kind === kind).map(entry => [entry.userId, now + Math.max(0, Math.min(ACTIVITY_TTL_MS, Number(entry.ttlMs) || 0))])
    : (payload[kind === 'typing' ? 'typingUserIds' : 'recordingUserIds'] || []).map(id => [id, now + ACTIVITY_TTL_MS]);
  return new Map(entries);
}
export function activeUserIds(map, now = Date.now(), hidden = new Set(), selfId) {
  return [...(map || [])].filter(([id, expires]) => expires > now && id !== selfId && !hidden.has(id)).map(([id]) => id);
}

export function createActivitySender({ typing, stopTyping, recording, stopRecording, canSignal = () => true,
  now = Date.now, later = setTimeout, cancel = clearTimeout, repeat = setInterval, stopRepeat = clearInterval }) {
  let lastTyping = -Infinity; let idle; let recorder; let typingActive = false; let recordingActive = false;
  const endTyping = () => {
    if (idle) cancel(idle); idle = null;
    if (typingActive) stopTyping?.();
    typingActive = false; lastTyping = -Infinity;
  };
  const endRecording = () => {
    if (recorder) stopRepeat(recorder); recorder = null;
    if (recordingActive) stopRecording?.();
    recordingActive = false;
  };
  return {
    textChanged(value) {
      if (!value.trim() || !canSignal()) { endTyping(); return; }
      if (recordingActive) return;
      if (idle) cancel(idle);
      idle = later(endTyping, 3000);
      if (now() - lastTyping < ACTIVITY_PULSE_MS) return;
      lastTyping = now(); typingActive = true; typing?.();
    },
    startRecording() {
      endTyping();
      if (recordingActive) return;
      recordingActive = true;
      const pulse = () => { if (canSignal()) recording?.(); };
      pulse(); recorder = repeat(pulse, ACTIVITY_PULSE_MS);
    },
    endTyping, endRecording,
    stop() { endTyping(); endRecording(); },
    dispose() { endTyping(); endRecording(); },
  };
}

// Redis assigns one room version across API instances. Late snapshots or
// legacy delta events must not restore an indicator after a newer stop.
export function acceptsActivity(previous, payload) {
  return !Number.isSafeInteger(payload.activityVersion) || !Number.isSafeInteger(previous?.activityVersion) || payload.activityVersion >= previous.activityVersion;
}
